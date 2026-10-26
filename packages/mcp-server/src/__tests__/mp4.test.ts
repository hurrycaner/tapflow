import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnvelopeHeader, CODEC_H264 } from '@tapflowio/agent-core/utils'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'
import { inspectFrame, type FrameInfo } from '../recording/annexb'
import { Mp4Segment, NotPrimedError, MAX_QUEUED_BYTES } from '../recording/mp4'

// 1280x720 baseline SPS, hand-packed as in annexb.test.ts.
function spsNal(): Uint8Array {
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
  ue(79); ue(44); u(1, 1); u(1, 1); u(1, 0); u(1, 0)
  while (bits.length % 8) bits.push(0)
  const out = [0x67]
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return new Uint8Array(out)
}

const SPS = spsNal()
const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80])
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21, 0xff])
const P = new Uint8Array([0x41, 0x9a, 0x24, 0x6c])
const T0 = 1_700_000_000_000

function annexb(...nals: Uint8Array[]): Uint8Array {
  return Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])))
}

function frame(payload: Uint8Array, keyframe: boolean, at: number): FrameInfo {
  const buf = writeEnvelopeHeader(Buffer.from(payload), at, { codec: CODEC_H264, keyframe })
  const info = inspectFrame(buf)
  if (!info) throw new Error('fixture has no envelope')
  return info
}

const key = (at = T0) => frame(annexb(SPS, PPS, IDR), true, at)
const delta = (at: number, extra = 0) =>
  frame(annexb(extra ? new Uint8Array([...P, ...new Uint8Array(extra)]) : P), false, at)

interface Box { type: string; offset: number; size: number }

async function walkBoxes(path: string): Promise<Box[]> {
  const fh = await open(path, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const boxes: Box[] = []
    let off = 0
    while (off + 8 <= fileSize) {
      const head = Buffer.alloc(16)
      await fh.read(head, 0, 16, off)
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (size === 1) size = Number(head.readBigUInt64BE(8))
      if (size === 0) size = fileSize - off
      boxes.push({ type, offset: off, size })
      off += size
    }
    return boxes
  } finally {
    await fh.close()
  }
}

async function readBack(path: string) {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('no video track')
  const sink = new EncodedPacketSink(track)
  const packets = []
  for await (const p of sink.packets()) packets.push(p)
  return {
    input,
    track,
    packets,
    codec: await track.getCodecParameterString(),
    duration: await track.computeDuration(),
    tracks: await input.getTracks(),
  }
}

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mp4-test-'))
  path = join(dir, 'out.mp4')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function happy(): Promise<Mp4Segment> {
  const seg = await Mp4Segment.open(path)
  seg.add(key())
  for (let i = 1; i <= 5; i++) seg.add(delta(T0 + i * 33))
  return seg
}

describe('Mp4Segment', () => {
  it('writes key + 5 deltas: ftyp first, moov after mdat, avc1 1280x720, 6 packets, ~198 ms', async () => {
    const seg = await happy()
    const res = await seg.finalize()
    expect(res.bytes).toBeGreaterThan(0)
    expect(res).toMatchObject({ path, width: 1280, height: 720, packets: 6, dropped: 0 })
    expect(Math.abs(res.durationMs - 198)).toBeLessThanOrEqual(1)

    const boxes = await walkBoxes(path)
    expect(boxes[0]!.type).toBe('ftyp')
    const mdat = boxes.find((b) => b.type === 'mdat')!
    const moov = boxes.find((b) => b.type === 'moov')!
    expect(moov.offset).toBeGreaterThan(mdat.offset)

    const back = await readBack(path)
    expect(back.tracks.filter((t) => t.isVideoTrack())).toHaveLength(1)
    expect(back.codec).toMatch(/^avc1/)
    expect(back.track.codedWidth).toBe(1280)
    expect(back.track.codedHeight).toBe(720)
    expect(back.packets).toHaveLength(6)
    expect(Math.abs(back.duration * 1000 - 198)).toBeLessThanOrEqual(1)
  })

  it('R9 observed: mediabunny KEEPS in-band SPS/PPS in the first sample', async () => {
    const seg = await happy()
    await seg.finalize()
    const { packets } = await readBack(path)
    const sample = packets[0]!.data
    // Samples are 4-byte length-prefixed: walk them and collect NAL types.
    const types: number[] = []
    for (let i = 0; i + 4 <= sample.length; ) {
      const len = Buffer.from(sample).readUInt32BE(i)
      types.push(sample[i + 4]! & 0x1f)
      i += 4 + len
    }
    expect(types).toEqual([7, 8, 5])
  })

  it('keeps packet timestamps non-decreasing when capturedAt steps back 50 ms', async () => {
    const seg = await Mp4Segment.open(path)
    seg.add(key())
    seg.add(delta(T0 + 33))
    seg.add(delta(T0 + 66))
    seg.add(delta(T0 + 66 - 50)) // frame 3 goes backwards
    seg.add(delta(T0 + 132))
    await seg.finalize()
    const { packets } = await readBack(path)
    expect(packets).toHaveLength(5)
    const ts = packets.map((p) => p.timestamp)
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!)
    expect(ts[3]).toBeCloseTo(0.066, 3)
  })

  it('gives a single packet a 1/30 s duration', async () => {
    const seg = await Mp4Segment.open(path)
    seg.add(key())
    const res = await seg.finalize()
    expect(res.packets).toBe(1)
    expect(res.durationMs).toBe(Math.round(1000 / 30))
  })

  it('does not throw on a first delta and finalize rejects with NotPrimedError (an unprimed file must never be uploaded)', async () => {
    const seg = await Mp4Segment.open(path)
    expect(() => seg.add(delta(T0))).not.toThrow()
    await expect(seg.finalize()).rejects.toBeInstanceOf(NotPrimedError)
  })

  it('ignores deltas before the first key, then muxes from the key', async () => {
    const seg = await Mp4Segment.open(path)
    seg.add(delta(T0))
    seg.add(key(T0 + 10))
    seg.add(delta(T0 + 43))
    const res = await seg.finalize()
    expect(res.packets).toBe(2)
  })

  it('finalize is idempotent: two calls return the same result', async () => {
    const seg = await happy()
    const [a, b] = [seg.finalize(), seg.finalize()]
    expect(a).toBe(b)
    expect(await a).toBe(await b)
    expect(await seg.finalize()).toBe(await a)
  })

  it('drops frames past MAX_QUEUED_BYTES until the next key and still finalizes', async () => {
    const seg = await Mp4Segment.open(path)
    seg.add(key())
    const big = 1024 * 1024
    // add() is synchronous, so none of these can drain before the loop ends.
    for (let i = 1; i <= MAX_QUEUED_BYTES / big + 8; i++) seg.add(delta(T0 + i * 33, big))
    const res = await seg.finalize()
    expect(res.dropped).toBeGreaterThan(0)
    const back = await readBack(path)
    expect(back.packets.length).toBe(res.packets)
    expect(Buffer.byteLength(await readFile(path))).toBe(res.bytes)
  })

  it('rejects open on an unwritable path', async () => {
    await expect(Mp4Segment.open('/nonexistent-dir/x.mp4')).rejects.toBeDefined()
  })
})
