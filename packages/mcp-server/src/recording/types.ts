import type { Mp4Segment } from './mp4.js'

/**
 * Per-segment cap (C9). Same value as flow-runner's MAX_FLOW_VIDEO_BYTES, because the relay's recordings
 * store already accepts files of that size from the dashboard and a larger MCP upload would be the only
 * thing that can exceed what the rest of the product was sized for. Kept as an own constant rather than
 * an import: mcp-server must not take a runtime dependency on flow-runner internals for one number.
 */
export const SEGMENT_CAP_BYTES = 100 * 1024 * 1024
/** Ceiling across all segments of one recording (C9, V5). */
export const TOTAL_CAP_BYTES = 500 * 1024 * 1024
/** Bound on waiting for the first decodable key after `stream:true` (C6, V19). */
export const PRIMING_MS = 5_000
/** Bound on waiting for a key after a mid-recording gap (C9, V19). Longer: nothing blocks on it. */
export const REPRIMING_MS = 30_000
/** Re-send period of `session:stream{true}` while unprimed; each one re-arms the relay's throttled IDR request (C6). */
export const RESEND_MS = 600
/** Frames held while the next segment's file opens (C10); past it they are dropped until the next key (C13, V29). */
export const ROLLOVER_BUFFER_BYTES = 16 * 1024 * 1024

export type UploadState =
  | { state: 'done'; url: string }
  | { state: 'pending'; reason?: 'token' }
  | { state: 'failed'; status: number | null; tmpPath: string; reason: string }

export interface SegmentEntry {
  index: number
  bytes: number
  durationMs: number
  width: number
  height: number
  /** Absent when `error` is set: a segment that never finalized has nothing to upload (C9, V30). */
  upload?: UploadState
  error?: string
}

export type EndReason = 'stopped' | 'size-limit' | 'cut-short' | 'no-keyframe' | 'write-error'

/** SPEC §I RecordingResult. */
export interface RecordingResult {
  recordingId: string
  sessionId: string
  buildId: number
  state: 'priming' | 'recording' | 'rolling' | 're-priming' | 'uploading' | 'done'
  endReason?: EndReason
  segments: SegmentEntry[]
  pending: number
  toggleNote?: string
}

export interface UploadJob {
  recordingId: string
  sessionId: string
  buildId: number
  index: number
  path: string
  bytes: number
}

/** Implemented by the uploader (T7); results come back through `RecordingManager.setUploadState`. */
export interface UploadLane {
  enqueue(job: UploadJob): void
}

export type SegmentWriter = Pick<Mp4Segment, 'add' | 'finalize'>

/** The slice of TapflowClient a recorder needs. */
export interface RecorderClient {
  setStream(sessionId: string, stream: boolean): Promise<void>
  isHeld(sessionId: string): boolean
}

export type CutShortReason = 'disconnect' | 'terminated' | 'socket-closed' | 'exit'

export class AlreadyRecordingError extends Error {
  constructor(readonly activeSessionId: string, readonly activeRecordingId: string) {
    super(`already-recording (session ${activeSessionId})`)
    this.name = 'AlreadyRecordingError'
  }
}
export class NoKeyframeError extends Error {
  constructor() {
    super('no decodable keyframe arrived while priming')
    this.name = 'NoKeyframeError'
  }
}
export class JpegStreamError extends Error {
  constructor() {
    super('the device streams JPEG; recording needs H.264')
    this.name = 'JpegStreamError'
  }
}
export class StoppedBeforeKeyframeError extends Error {
  constructor() {
    super('stopped before a keyframe')
    this.name = 'StoppedBeforeKeyframeError'
  }
}
export class NotHeldError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is not held by this client`)
    this.name = 'NotHeldError'
  }
}
