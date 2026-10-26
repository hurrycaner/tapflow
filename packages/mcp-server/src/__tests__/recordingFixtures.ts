import { vi } from 'vitest'
import { writeEnvelopeHeader, CODEC_H264, CODEC_JPEG, CODEC_AUDIO } from '@tapflowio/agent-core/utils'
import type { FrameInfo } from '../recording/annexb'
import type { SegmentResult } from '../recording/mp4'
import type { RecorderClient, SegmentWriter, UploadJob, UploadLane } from '../recording/types'

// Baseline SPS, hand-packed as in annexb.test.ts; the macroblock counts pick the dimensions.
export function spsNal(widthMbs = 80, heightMbs = 45): Uint8Array {
  const bits: number[] = []
  const u = (n: number, v: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1) }
  const ue = (v: number) => {
    const code = v + 1
    const len = Math.floor(Math.log2(code))
    for (let i = 0; i < len; i++) bits.push(0)
    u(len + 1, code)
  }
  u(8, 66); u(8, 0xc0); u(8, 31)
  ue(0); ue(0); ue(0); ue(0); ue(1); u(1, 0)
  ue(widthMbs - 1); ue(heightMbs - 1); u(1, 1); u(1, 1); u(1, 0); u(1, 0)
  while (bits.length % 8) bits.push(0)
  const out = [0x67]
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return new Uint8Array(out)
}

export const SPS_720P = spsNal() // 1280x720
export const SPS_PORTRAIT = spsNal(45, 80) // 720x1280
const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80])
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21, 0xff])
const P = new Uint8Array([0x41, 0x9a, 0x24, 0x6c])
export const T0 = 1_700_000_000_000

function annexb(...nals: Uint8Array[]): Buffer {
  return Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])))
}

export const keyFrame = (at = T0, sps = SPS_720P): Buffer =>
  writeEnvelopeHeader(annexb(sps, PPS, IDR), at, { codec: CODEC_H264, keyframe: true })
/** A keyframe-flagged IDR with no SPS: scrcpy's periodic one. */
export const keyNoSps = (at = T0): Buffer =>
  writeEnvelopeHeader(annexb(IDR), at, { codec: CODEC_H264, keyframe: true })
/** A keyframe-flagged IDR carrying SPS but no PPS: dims parse, but mediabunny's avcC needs both (R8/R11). */
export const keySpsNoPps = (at = T0, sps = SPS_720P): Buffer =>
  writeEnvelopeHeader(annexb(sps, IDR), at, { codec: CODEC_H264, keyframe: true })
export const deltaFrame = (at: number): Buffer =>
  writeEnvelopeHeader(annexb(P), at, { codec: CODEC_H264, keyframe: false })
export const jpegFrame = (at = T0): Buffer =>
  writeEnvelopeHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), at, { codec: CODEC_JPEG })
export const audioFrame = (at = T0): Buffer =>
  writeEnvelopeHeader(Buffer.from([1, 2, 3, 4]), at, { codec: CODEC_AUDIO })

// Cap tests need frames bigger than 100 MB of muxed bytes. Built once and reused: the recorder only
// reads them, and a fresh 60 MB buffer per frame would make the ceiling test allocate gigabytes.
let bigDelta105: Buffer | undefined
let bigKey60: Buffer | undefined
/** A delta whose payload alone exceeds the 100 MB segment cap. */
export function hugeDelta(): Buffer {
  bigDelta105 ??= writeEnvelopeHeader(
    annexb(Buffer.concat([P, Buffer.alloc(105 * 1024 * 1024)])),
    T0 + 1,
    { codec: CODEC_H264, keyframe: false },
  )
  return bigDelta105
}
/** A decodable key of ~60 MB: two of them in one segment cross the cap, nine in a recording cross 500 MB. */
export function bigKey(): Buffer {
  bigKey60 ??= writeEnvelopeHeader(
    annexb(SPS_720P, PPS, Buffer.concat([IDR, Buffer.alloc(60 * 1024 * 1024)])),
    T0 + 2,
    { codec: CODEC_H264, keyframe: true },
  )
  return bigKey60
}

export interface Gate { promise: Promise<void>; open(): void }
export function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}

export interface FakeWriter extends SegmentWriter {
  path: string
  index: number
  adds: FrameInfo[]
  finalize: ReturnType<typeof vi.fn<() => Promise<SegmentResult>>>
}

export interface HarnessOptions {
  /** Open of this segment index rejects. */
  openFails?: (index: number) => boolean
  /** Finalize of this segment index rejects. */
  finalizeFails?: (index: number) => boolean
  /** Finalize of this segment index waits for the gate. */
  finalizeGate?: (index: number) => Gate | undefined
  /** The nth (1-based) add on this segment index reports a write failure, as a real writer does once it hit one. */
  addFailsAt?: (index: number, nth: number) => boolean
  held?: boolean
}

export function makeHarness(opts: HarnessOptions = {}) {
  const log: string[] = []
  const jobs: UploadJob[] = []
  const removed: string[] = []
  const writers: FakeWriter[] = []
  const state = { held: opts.held ?? true }
  const indexOf = (p: string): number => Number(/-(\d+)\.mp4$/.exec(p)?.[1])

  const setStream = vi.fn(async (_session: string, stream: boolean): Promise<void> => {
    log.push(`toggle:${stream}`)
  })
  const client: RecorderClient & { setStream: typeof setStream; isHeld: ReturnType<typeof vi.fn<() => boolean>> } = {
    setStream,
    isHeld: vi.fn(() => state.held),
  }
  const lane: UploadLane & { enqueue: ReturnType<typeof vi.fn<(job: UploadJob) => void>> } = {
    enqueue: vi.fn((job: UploadJob) => {
      log.push(`lane:${job.index}`)
      jobs.push(job)
    }),
  }
  const openSegment = vi.fn(async (path: string): Promise<SegmentWriter> => {
    const index = indexOf(path)
    log.push(`open:${index}`)
    if (opts.openFails?.(index)) throw new Error(`EACCES: ${path}`)
    const adds: FrameInfo[] = []
    let failed = false
    const w: FakeWriter = {
      path,
      index,
      adds,
      add: (f: FrameInfo) => {
        adds.push(f)
        log.push(`add:${index}`)
        if (opts.addFailsAt?.(index, adds.length)) failed = true
        return !failed
      },
      finalize: vi.fn(async (): Promise<SegmentResult> => {
        log.push(`finalize:${index}`)
        await opts.finalizeGate?.(index)?.promise
        if (failed) throw new Error('EIO')
        if (opts.finalizeFails?.(index)) throw new Error('ENOSPC')
        return { path, bytes: 1000 + index, durationMs: 500, width: 1280, height: 720, packets: adds.length, dropped: 0 }
      }),
    }
    writers.push(w)
    return w
  })
  const removeFile = async (p: string): Promise<void> => { removed.push(p) }
  return { log, jobs, removed, writers, state, client, lane, openSegment, removeFile }
}

/** Lets promise chains and zero-delay timers settle under fake timers. */
export async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}
