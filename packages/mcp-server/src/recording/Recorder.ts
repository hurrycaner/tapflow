import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { StreamRefusedError } from '../client.js'
import { inspectFrame, type FrameInfo } from './annexb.js'
import {
  JpegStreamError,
  NoKeyframeError,
  PRIMING_MS,
  REPRIMING_MS,
  RESEND_MS,
  ROLLOVER_BUFFER_BYTES,
  SEGMENT_CAP_BYTES,
  StoppedBeforeKeyframeError,
  TOTAL_CAP_BYTES,
  type CutShortReason,
  type EndReason,
  type RecorderClient,
  type RecordingResult,
  type SegmentEntry,
  type SegmentWriter,
  type UploadLane,
  type UploadState,
} from './types.js'

type Phase = RecordingResult['state']
const ACTIVE: ReadonlySet<Phase> = new Set<Phase>(['priming', 'recording', 'rolling', 're-priming'])

export interface RecorderDeps {
  recordingId: string
  sessionId: string
  buildId: number
  client: RecorderClient
  openSegment: (path: string) => Promise<SegmentWriter>
  tmpDir: string
  lane: UploadLane
  /** Tests observe tmp cleanup through it; defaults to `fs.rm(force)`. */
  removeFile?: (path: string) => Promise<void>
}

interface Current {
  index: number
  path: string
  writer: SegmentWriter
  width: number
  height: number
  bytesMuxed: number
}

/** A key the muxer can be primed on: IDR + SPS + PPS, and dimensions parsed from that SPS. */
function isPrimer(f: FrameInfo): f is FrameInfo & { dims: { width: number; height: number } } {
  return f.codec === 'h264' && f.decodableKey && f.dims !== null
}

const noop = (): void => undefined

/** One recording: priming, segments, rollover, and the exit path. Never throws from `onFrame`. */
export class Recorder {
  readonly recordingId: string
  readonly sessionId: string
  readonly buildId: number

  private readonly client: RecorderClient
  private readonly openSegment: (path: string) => Promise<SegmentWriter>
  private readonly tmpDir: string
  private readonly lane: UploadLane
  private readonly removeFile: (path: string) => Promise<void>

  // The slot is claimed by the manager before start(), so a recorder is `priming` from construction (V15).
  private phase: Phase = 'priming'
  private endReason: EndReason | undefined
  private toggleNote: string | undefined
  private readonly segments: SegmentEntry[] = []
  private readonly paths = new Map<number, string>()
  private current: Current | null = null
  /** Files whose finalize has not settled: still the only copy if the process dies now (V22). */
  private readonly finalizing = new Set<string>()
  private nextIndex = 0
  private bytesTotal = 0
  private toggled = false
  /** True from the first stream:true until stream:false has settled (or none was ever sent). */
  private streamOn = false
  private writeFailed = false
  private closed = false

  private resendTimer: ReturnType<typeof setTimeout> | null = null
  private primeTimer: ReturnType<typeof setTimeout> | null = null
  private reprimeTimer: ReturnType<typeof setTimeout> | null = null

  /** Settles the previous segment's finalize; the next segment's first add waits on it (V25). */
  private prevFinal: Promise<boolean> | null = null
  private opening: Promise<void> | null = null
  private buffer: FrameInfo[] = []
  private bufferBytes = 0
  private gap = false

  /** One shared promise for stop, cut-short and every self-inflicted ending (V17). */
  private closing: Promise<RecordingResult> | null = null
  private idleWaiters: Array<() => void> = []

  private readonly primed: {
    promise: Promise<{ width: number; height: number }>
    resolve: (v: { width: number; height: number }) => void
    reject: (e: unknown) => void
  }

  constructor(deps: RecorderDeps) {
    this.recordingId = deps.recordingId
    this.sessionId = deps.sessionId
    this.buildId = deps.buildId
    this.client = deps.client
    this.openSegment = deps.openSegment
    this.tmpDir = deps.tmpDir
    this.lane = deps.lane
    this.removeFile = deps.removeFile ?? ((p) => rm(p, { force: true }))
    let resolve!: (v: { width: number; height: number }) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<{ width: number; height: number }>((res, rej) => {
      resolve = res
      reject = rej
    })
    // start() may not be awaiting yet when a stop rejects this; the caller still gets the raw promise.
    promise.catch(noop)
    this.primed = { promise, resolve, reject }
  }

  isActive(): boolean {
    return ACTIVE.has(this.phase)
  }

  /** The relay's per-session stream flag is off again: only then may another recorder claim the frame slot. */
  get streamOff(): boolean {
    return !this.streamOn
  }

  result(): RecordingResult {
    return {
      recordingId: this.recordingId,
      sessionId: this.sessionId,
      buildId: this.buildId,
      state: this.phase,
      ...(this.endReason ? { endReason: this.endReason } : {}),
      segments: structuredClone(this.segments),
      pending: this.pendingCount(),
      ...(this.toggleNote ? { toggleNote: this.toggleNote } : {}),
    }
  }

  /** Resolves with the dimensions of the first decodable key. */
  async start(): Promise<{ width: number; height: number }> {
    this.nextIndex = 1
    // C4: the file exists before the toggle, so an unwritable tmp costs no toggle.
    let writer: SegmentWriter
    try {
      writer = await this.openSegment(this.segmentPath(0))
    } catch (e) {
      this.cancelTimers()
      this.phase = 'done'
      this.closed = true
      this.closing ??= Promise.resolve(this.result())
      throw e
    }
    const seg: Current = { index: 0, path: this.segmentPath(0), writer, width: 0, height: 0, bytesMuxed: 0 }
    if (this.closing) {
      // A stop landed while the file was opening; it had nothing to clean up yet.
      await this.dispose(seg)
      return this.primed.promise
    }
    this.current = seg

    this.toggled = true
    this.streamOn = true
    try {
      await this.client.setStream(this.sessionId, true)
    } catch (e) {
      // A refusal means the relay did not turn the stream on; anything else (timeout) is ambiguous.
      if (e instanceof StreamRefusedError) {
        this.toggled = false
        this.streamOn = false
      }
      await this.teardownPriming(undefined)
      throw e
    }
    if (this.closing) return this.primed.promise

    // C6/V19: every re-send re-arms the relay's throttled IDR request until a key lands.
    this.startResend()
    this.primeTimer = setTimeout(() => {
      void this.failPriming(new NoKeyframeError(), undefined)
    }, PRIMING_MS)
    return this.primed.promise
  }

  /** Synchronous and never throws: it runs inside the websocket message handler (C13, V29). */
  onFrame(frame: Buffer): void {
    try {
      this.handleFrame(frame)
    } catch {
      void this.close('write-error')
    }
  }

  /** Re-sends `stream:true`; also used for a re-join, which resets the relay's flag (C2b, V24). */
  resendStream(): void {
    // No isActive() check here on purpose: the cancelled timer is what keeps a re-send from trailing the exit toggle (V27).
    if (!this.toggled) return
    void (async () => {
      try {
        await this.client.setStream(this.sessionId, true)
      } catch (e) {
        this.note(e)
      }
    })()
  }

  stop(): Promise<RecordingResult> {
    return this.end('stopped')
  }

  cutShort(_reason: CutShortReason): Promise<RecordingResult> {
    return this.end('cut-short')
  }

  /** Records a lane outcome for a segment (T7 reports through the manager). */
  setUpload(index: number, upload: UploadState): void {
    const seg = this.segments.find((s) => s.index === index)
    if (!seg || seg.error) return
    seg.upload = upload
    this.refresh()
  }

  /** tmp files that still hold the only copy of a segment (V22). */
  keptPaths(): string[] {
    const out: string[] = []
    for (const s of this.segments) {
      if (s.error || !s.upload || s.upload.state === 'done') continue
      out.push(s.upload.state === 'failed' ? s.upload.tmpPath : (this.paths.get(s.index) ?? ''))
    }
    if (this.current) out.push(this.current.path)
    out.push(...this.finalizing)
    return out.filter((p) => p !== '')
  }

  /** Resolves once the recording ended and no upload is pending. */
  whenSettled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  // ---- frames -------------------------------------------------------------------------------------------

  private handleFrame(frame: Buffer): void {
    // V11: anything after stop is ignored, and so is anything while no phase wants frames.
    if (!this.isActive()) return
    const f = inspectFrame(frame)
    if (!f || f.codec === 'audio') return // V9, C14

    switch (this.phase) {
      case 'priming':
        if (f.codec === 'jpeg') {
          void this.failPriming(new JpegStreamError(), undefined) // C8
        } else if (isPrimer(f)) {
          this.prime(f)
        }
        return
      case 'recording':
        if (f.codec === 'h264') this.onRecordingFrame(f)
        return
      case 'rolling':
        if (f.codec === 'h264') this.bufferFrame(f)
        return
      case 're-priming':
        // C9: frames are dropped until a decodable key; that key is the next segment's first add.
        if (isPrimer(f) && this.prevFinal) this.beginSegment(f, this.prevFinal)
        return
      default:
        return
    }
  }

  private prime(f: FrameInfo & { dims: { width: number; height: number } }): void {
    const cur = this.current
    if (!cur) return
    this.cancelTimers() // C6: dead before anything that could toggle off (V27)
    cur.width = f.dims.width
    cur.height = f.dims.height
    this.mux(cur, f)
    this.phase = 'recording'
    this.primed.resolve({ width: cur.width, height: cur.height })
  }

  private onRecordingFrame(f: FrameInfo): void {
    const cur = this.current
    if (!cur) return
    // C13: after a rollover-buffer overflow a delta would reference a frame that was dropped; wait for a key.
    if (this.gap) {
      if (!(f.keyframe || f.decodableKey)) return
      this.gap = false
    }
    const len = f.payload.length
    // C9 (c), checked before the per-segment cap: the ceiling ends the recording, a rollover would not.
    if (this.bytesTotal + len > TOTAL_CAP_BYTES) {
      void this.close('size-limit')
      return
    }
    // C10 (a): a keyframe without SPS has `dims === null`, which reads as "unchanged", never an error.
    if (isPrimer(f) && (f.dims.width !== cur.width || f.dims.height !== cur.height)) {
      this.retire(cur)
      this.beginSegment(f, this.prevFinal ?? Promise.resolve(true))
      return
    }
    // C9 (b): the first packet whose add would cross the cap.
    if (cur.bytesMuxed + len > SEGMENT_CAP_BYTES) {
      this.retire(cur)
      if (isPrimer(f)) {
        this.beginSegment(f, this.prevFinal ?? Promise.resolve(true))
      } else {
        this.enterRePriming()
      }
      return
    }
    this.mux(cur, f)
  }

  private mux(cur: Current, f: FrameInfo): void {
    const ok = cur.writer.add(f)
    cur.bytesMuxed += f.payload.length
    this.bytesTotal += f.payload.length
    // A failed write ends the recording now; finalize reports the error on the segment (V30).
    if (!ok) void this.close('write-error')
  }

  /** Detaches the current segment and starts its finalize; a failure ends the recording (C9, V30). */
  private retire(cur: Current): void {
    this.current = null
    const p = this.finalizeSegment(cur)
    this.prevFinal = p
    void p.then((ok) => {
      if (!ok) void this.close('write-error')
    })
  }

  private enterRePriming(): void {
    this.phase = 're-priming'
    this.startResend() // V19/V25: same loop as priming
    this.reprimeTimer = setTimeout(() => {
      void this.close('no-keyframe')
    }, REPRIMING_MS)
  }

  /** `first` is a decodable key; it becomes the new segment's first add once old is finalized and new is open. */
  private beginSegment(first: FrameInfo & { dims: { width: number; height: number } }, prevFinal: Promise<boolean>): void {
    this.cancelTimers()
    this.phase = 'rolling'
    const index = this.nextIndex++
    this.buffer = [first]
    this.bufferBytes = first.payload.length
    this.gap = false
    const { width, height } = first.dims
    this.opening = (async () => {
      try {
        // V25: old.finalize precedes new.first add.
        if (!(await prevFinal)) return
        let writer: SegmentWriter
        const path = this.segmentPath(index)
        try {
          writer = await this.openSegment(path)
        } catch (e) {
          this.segments.push({ index, bytes: 0, durationMs: 0, width, height, error: errorText(e) })
          this.writeFailed = true
          void this.close('write-error')
          return
        }
        const cur: Current = { index, path, writer, width, height, bytesMuxed: 0 }
        this.current = cur
        const held = this.buffer
        this.buffer = []
        this.bufferBytes = 0
        for (const f of held) this.mux(cur, f)
        if (this.phase === 'rolling') this.phase = 'recording'
      } catch {
        this.writeFailed = true
        void this.close('write-error')
      }
    })()
  }

  /** C10/C13: frames that arrive while the next file opens wait here, bounded, then drop until a key. */
  private bufferFrame(f: FrameInfo): void {
    const isKey = f.keyframe || f.decodableKey
    if (this.gap && !isKey) return
    if (this.bufferBytes + f.payload.length > ROLLOVER_BUFFER_BYTES) {
      this.gap = true
      return
    }
    this.gap = false
    this.buffer.push(f)
    this.bufferBytes += f.payload.length
  }

  // ---- finalize and the exit path ---------------------------------------------------------------------

  /** True when the segment was finalized and handed to the lane. Never rejects. */
  private finalizeSegment(seg: Current): Promise<boolean> {
    this.finalizing.add(seg.path)
    return Promise.resolve()
      .then(() => seg.writer.finalize())
      .finally(() => this.finalizing.delete(seg.path))
      .then(
        (res) => {
          const entry: SegmentEntry = {
            index: seg.index,
            bytes: res.bytes,
            durationMs: res.durationMs,
            width: res.width,
            height: res.height,
            upload: { state: 'pending' },
          }
          this.segments.push(entry)
          this.paths.set(seg.index, res.path)
          try {
            this.lane.enqueue({
              recordingId: this.recordingId,
              sessionId: this.sessionId,
              buildId: this.buildId,
              index: seg.index,
              path: res.path,
              bytes: res.bytes,
            })
          } catch (e) {
            entry.upload = { state: 'failed', status: null, tmpPath: res.path, reason: errorText(e) }
          }
          this.refresh()
          return true
        },
        async (e: unknown) => {
          // V30: no lane entry, tmp removed, the segment is reported with an error.
          this.writeFailed = true
          this.segments.push({
            index: seg.index,
            bytes: 0,
            durationMs: 0,
            width: seg.width,
            height: seg.height,
            error: errorText(e),
          })
          await this.removeFile(seg.path).catch(noop)
          this.refresh()
          return false
        },
      )
  }

  private end(reason: 'stopped' | 'cut-short'): Promise<RecordingResult> {
    if (this.closing) return this.closing
    // C12: stop during priming makes the pending start reply "stopped before a keyframe".
    if (this.phase === 'priming') return this.failPriming(new StoppedBeforeKeyframeError(), reason)
    return this.close(reason)
  }

  /** Shared by stop, cut-short and every internal ending; the second caller awaits the first (V17). */
  private close(reason: EndReason): Promise<RecordingResult> {
    if (this.closing) return this.closing
    this.cancelTimers() // V19/V23: dead before the exit toggle
    this.phase = 'uploading'
    this.endReason = reason
    this.closing = this.runClose(reason)
    return this.closing
  }

  private async runClose(reason: EndReason): Promise<RecordingResult> {
    try {
      await this.opening
      await this.prevFinal
      const cur = this.current
      if (cur) {
        this.current = null
        await this.finalizeSegment(cur)
      }
      // V23: finalize → lane (inside finalizeSegment) → toggle. Its outcome never changes the result.
      await this.toggleOff()
    } catch {
      this.writeFailed = true
    }
    this.endReason = this.writeFailed ? 'write-error' : reason
    this.closed = true
    this.refresh()
    return this.result()
  }

  private failPriming(err: Error, endReason: EndReason | undefined): Promise<RecordingResult> {
    const done = this.teardownPriming(endReason)
    return done.then((r) => {
      this.primed.reject(err)
      return r
    })
  }

  /** Leaves `priming` without a segment: no lane job, no tmp file, no stream left on. */
  private teardownPriming(endReason: EndReason | undefined): Promise<RecordingResult> {
    if (this.closing) return this.closing
    this.cancelTimers() // V27: before any toggle
    this.phase = 'done'
    this.endReason = endReason
    this.closing = (async () => {
      await this.toggleOff()
      const cur = this.current
      this.current = null
      if (cur) await this.dispose(cur)
      this.closed = true
      this.refresh()
      return this.result()
    })()
    return this.closing
  }

  /** V1: stream:false only while held, and only if this recorder turned it on. */
  private async toggleOff(): Promise<void> {
    if (!this.toggled || !this.client.isHeld(this.sessionId)) {
      this.streamOn = false
      return
    }
    this.toggled = false
    try {
      await this.client.setStream(this.sessionId, false)
    } catch (e) {
      this.note(e)
    } finally {
      this.streamOn = false
    }
  }

  private async dispose(seg: Current): Promise<void> {
    await Promise.resolve()
      .then(() => seg.writer.finalize())
      .catch(noop)
    await this.removeFile(seg.path).catch(noop)
  }

  // ---- small helpers -----------------------------------------------------------------------------------

  private startResend(): void {
    const tick = (): void => {
      this.resendTimer = setTimeout(() => {
        this.resendStream()
        tick()
      }, RESEND_MS)
    }
    if (this.resendTimer === null) tick()
  }

  private cancelTimers(): void {
    for (const t of [this.resendTimer, this.primeTimer, this.reprimeTimer]) if (t !== null) clearTimeout(t)
    this.resendTimer = this.primeTimer = this.reprimeTimer = null
  }

  private segmentPath(index: number): string {
    return join(this.tmpDir, `tapflow-rec-${this.recordingId}-${index}.mp4`)
  }

  private pendingCount(): number {
    return this.segments.filter((s) => s.upload?.state === 'pending').length
  }

  private isSettled(): boolean {
    return this.closed && this.pendingCount() === 0
  }

  private refresh(): void {
    if (this.closed && this.phase === 'uploading' && this.pendingCount() === 0) this.phase = 'done'
    if (this.isSettled()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }

  private note(e: unknown): void {
    this.toggleNote = `stream toggle failed: ${errorText(e)}`
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
