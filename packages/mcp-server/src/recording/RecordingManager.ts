import type { RecorderHooks } from '../client.js'
import { Recorder } from './Recorder.js'
import {
  AlreadyRecordingError,
  type RecorderClient,
  type RecordingResult,
  type SegmentWriter,
  type UploadLane,
  type UploadState,
} from './types.js'

export interface ManagerDeps {
  client: RecorderClient
  openSegment: (path: string) => Promise<SegmentWriter>
  tmpDir: string
  lane: UploadLane
  removeFile?: (path: string) => Promise<void>
  /** Defaults to process.stderr; the exit drain reports kept tmp paths here (V22). */
  stderr?: (line: string) => void
}

export interface StartResult {
  recorder: Recorder
  width: number
  height: number
  /** The session's prior result, only while it still has uploads pending (V18). */
  previous?: { recordingId: string; pending: number }
}

/** A claimed slot: the caller may do async checks (relay features, build lookup) before `start`. */
export interface RecordingClaim {
  recordingId: string
  release(): void
  start(buildId: number): Promise<StartResult>
}

interface Slot {
  sessionId: string
  recordingId: string
  recorder: Recorder | null
}

const noop = (): void => undefined

/**
 * The single active slot, results keyed by recordingId, and the fan-out of the client's recorder hooks.
 * Frames carry no session id and one socket holds n sessions, so at most one recorder is active (C11).
 */
export class RecordingManager implements RecorderHooks {
  private slot: Slot | null = null
  private readonly recorders = new Map<string, Recorder>()
  private readonly latestBySession = new Map<string, string>()

  constructor(private readonly deps: ManagerDeps) {}

  get results(): ReadonlyMap<string, RecordingResult> {
    return new Map([...this.recorders].map(([id, r]) => [id, r.result()]))
  }

  /**
   * Claims the slot synchronously, before any await (C11, V15): two concurrent starts cannot both pass
   * the check, because nothing yields between the check and the claim.
   */
  claim(sessionId: string, recordingId: string): RecordingClaim {
    const busy = this.busySlot()
    if (busy) throw new AlreadyRecordingError(busy.sessionId, busy.recordingId)
    const slot: Slot = { sessionId, recordingId, recorder: null }
    this.slot = slot
    return {
      recordingId,
      release: () => {
        if (this.slot === slot) this.slot = null
      },
      start: (buildId) => this.run(slot, buildId),
    }
  }

  async start(args: { sessionId: string; buildId: number; recordingId: string }): Promise<StartResult> {
    return this.claim(args.sessionId, args.recordingId).start(args.buildId)
  }

  activeRecorder(): Recorder | null {
    const rec = this.busySlot()?.recorder ?? null
    // A recorder that is only waiting for its stream to switch off holds the slot but takes no frames.
    return rec?.isActive() ? rec : null
  }

  /** The recorder a stop_recording should address: the session's active one, else its latest. */
  recorderFor(sessionId: string, recordingId?: string): Recorder | null {
    const id = recordingId ?? this.latestBySession.get(sessionId)
    const rec = id ? this.recorders.get(id) : undefined
    return rec && rec.sessionId === sessionId ? rec : null
  }

  /** The session's result (latest unless `recordingId` is given), or null when there is none (idle). */
  status(sessionId: string, recordingId?: string): RecordingResult | null {
    return this.recorderFor(sessionId, recordingId)?.result() ?? null
  }

  /** The lane reports an outcome here; pending is recomputed and finished results are released (V18). */
  setUploadState(recordingId: string, index: number, upload: UploadState): void {
    const rec = this.recorders.get(recordingId)
    if (!rec) return
    rec.setUpload(index, upload)
    this.maybeDrop(recordingId)
  }

  /** Resolves when the recording has no pending upload, or after `ms` (T8's waitMs). */
  async awaitUploads(recordingId: string, ms: number): Promise<void> {
    const rec = this.recorders.get(recordingId)
    if (!rec) return
    await raceTimeout(rec.whenSettled(), ms)
  }

  /** V22: cut the active recording short, give the lane `ms`, then name what stayed on disk. */
  async drainForExit(ms = 10_000): Promise<void> {
    const active = this.activeRecorder()
    const work = (async () => {
      if (active) await active.cutShort('exit')
      await Promise.all([...this.recorders.values()].map((r) => r.whenSettled()))
    })().catch(noop)
    await raceTimeout(work, ms)
    const out = this.deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`))
    for (const rec of this.recorders.values()) {
      for (const path of rec.keptPaths()) out(`tapflow-rec kept: ${path}`)
    }
  }

  // ---- RecorderHooks -----------------------------------------------------------------------------------

  isActive(sessionId: string): boolean {
    const rec = this.activeRecorder()
    return rec !== null && rec.sessionId === sessionId
  }

  onBinary(frame: Buffer): void {
    // V15: a frame reaches the active recorder and no other.
    this.activeRecorder()?.onFrame(frame)
  }

  onJoined(sessionId: string): void {
    const rec = this.activeRecorder()
    // C2b/V24: a re-join resets the relay's per-session flag, so the toggle is re-sent.
    if (rec && rec.sessionId === sessionId) rec.resendStream()
  }

  onTerminated(sessionId: string): void {
    const rec = this.activeRecorder()
    if (rec && rec.sessionId === sessionId) rec.cutShort('terminated').catch(noop)
  }

  onClose(): void {
    // V26: before waiters settle; toggle goes out only if the client still holds the session.
    this.activeRecorder()?.cutShort('socket-closed').catch(noop)
  }

  // ---- internals ---------------------------------------------------------------------------------------

  private async run(slot: Slot, buildId: number): Promise<StartResult> {
    const { sessionId, recordingId } = slot
    const priorId = this.latestBySession.get(sessionId)
    const recorder = new Recorder({
      recordingId,
      sessionId,
      buildId,
      client: this.deps.client,
      openSegment: this.deps.openSegment,
      tmpDir: this.deps.tmpDir,
      lane: this.deps.lane,
      removeFile: this.deps.removeFile,
    })
    slot.recorder = recorder
    this.recorders.set(recordingId, recorder)
    this.latestBySession.set(sessionId, recordingId)
    try {
      const dims = await recorder.start()
      // V18: a prior result with pending > 0 stays and is named; one without is released now that it is not latest.
      // Read now, not before priming: an upload may have finished (or the result been dropped) in the meantime.
      const priorResult = priorId ? this.recorders.get(priorId)?.result() : undefined
      if (priorId) this.maybeDrop(priorId)
      return {
        recorder,
        ...dims,
        ...(priorResult && priorResult.pending > 0
          ? { previous: { recordingId: priorResult.recordingId, pending: priorResult.pending } }
          : {}),
      }
    } catch (e) {
      // V8: a failed start leaves no slot and no result behind.
      this.recorders.delete(recordingId)
      if (priorId) this.latestBySession.set(sessionId, priorId)
      else this.latestBySession.delete(sessionId)
      if (this.slot === slot) this.slot = null
      throw e
    }
  }

  private busySlot(): Slot | null {
    const s = this.slot
    if (!s) return null
    if (s.recorder === null || s.recorder.isActive() || !s.recorder.streamOff) return s
    this.slot = null // the slot frees once the old stream is off, not when finalize starts (C11)
    return null
  }

  /** V18: dropped only when nothing is pending, the recording ended, and it is no longer the session's latest. */
  private maybeDrop(recordingId: string): void {
    const rec = this.recorders.get(recordingId)
    if (!rec) return
    const r = rec.result()
    if (r.pending === 0 && r.state === 'done' && this.latestBySession.get(rec.sessionId) !== recordingId) {
      this.recorders.delete(recordingId)
    }
  }
}

async function raceTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
