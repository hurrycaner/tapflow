import { describe, it, expect, vi, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '../tools.js'
import { StreamRefusedError, type TapflowClient } from '../client.js'
import { createRecording, type RecordingDeps } from '../recording/index.js'
import {
  AlreadyRecordingError,
  JpegStreamError,
  NoKeyframeError,
  StoppedBeforeKeyframeError,
  SEGMENT_CAP_BYTES,
  TOTAL_CAP_BYTES,
} from '../recording/types.js'

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

const text = (r: ToolResult) => r.content[0]?.text ?? ''
const later = () => new Promise<void>((r) => setTimeout(r, 0))

interface Rig {
  handlers: Map<string, Handler>
  client: Record<string, ReturnType<typeof vi.fn> | unknown>
  claim: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  recorderFor: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  awaitUploads: ReturnType<typeof vi.fn>
  resumeParked: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function rig(over: { feature?: boolean; held?: boolean; lookup?: unknown; released?: string } = {}): Rig {
  const release = vi.fn()
  const start = vi.fn(async () => ({ width: 390, height: 844 }))
  const claim = vi.fn(() => ({ recordingId: 'rec-1', release, start }))
  const stop = vi.fn(async () => ({}))
  const recorderFor = vi.fn((sessionId: string) => (sessionId === 's1' ? { recordingId: 'rec-1', stop } : null))
  const status = vi.fn(() => ({ recordingId: 'rec-1', state: 'done', pending: 0, segments: [] }))
  const awaitUploads = vi.fn(async () => {})
  const resumeParked = vi.fn()
  const client = {
    reconnectIfRotated: vi.fn(async () => {}),
    releasedByReconnect: vi.fn(() => over.released),
    reconnects: 0,
    // Resolves on a later tick, so a claim made after it would be observably late.
    hasFeature: vi.fn(async () => { await later(); return over.feature ?? true }),
    isHeld: vi.fn(() => over.held ?? true),
    lookupBuild: vi.fn(async () => over.lookup ?? { kind: 'found', bundleId: 'a.b' }),
    installApp: vi.fn(async () => {}),
  }
  const handlers = new Map<string, Handler>()
  const server = { registerTool: (n: string, _c: unknown, h: Handler) => { handlers.set(n, h) } }
  const deps = { manager: { claim, recorderFor, status, awaitUploads }, uploader: { resumeParked } }
  registerTools(server as unknown as McpServer, client as unknown as TapflowClient, deps as unknown as RecordingDeps)
  return { handlers, client, claim, release, start, recorderFor, status, awaitUploads, resumeParked, stop }
}

afterEach(() => { vi.useRealTimers() })

describe('start_recording', () => {
  const call = (r: Rig, args: Record<string, unknown> = { sessionId: 's1', buildId: 7 }) => r.handlers.get('start_recording')!(args)

  it('claims the slot synchronously, before the first await', async () => {
    const r = rig()
    const p = call(r)
    // The wrapper's own await of reconnectIfRotated is a few microtasks; hasFeature resolves on a timer, so
    // a claim made after it would not have happened yet.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(r.claim).toHaveBeenCalledTimes(1)
    expect(r.client['hasFeature']).toHaveBeenCalledTimes(1)
    await p
  })

  it.each([
    ['relay-too-old', { feature: false }, 'start_recording failed: relay-too-old — this relay does not answer session:stream; update the relay'],
    ['not-held', { held: false }, 'start_recording failed: not-held — call connect_device first'],
    ['build-not-found', { lookup: { kind: 'not-found' } }, 'start_recording failed: build-not-found (see list_builds)'],
    ['build-lookup-failed', { lookup: { kind: 'unknown', reason: 'timeout' } }, 'start_recording failed: build-lookup-failed: timeout'],
  ])('%s releases the claim once and never starts', async (_n, over, msg) => {
    const r = rig(over)
    const res = await call(r)
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(msg)
    expect(r.release).toHaveBeenCalledTimes(1)
    expect(r.start).not.toHaveBeenCalled()
  })

  it('checks the relay feature before the hold and the hold before the build', async () => {
    const r = rig({ feature: false, held: false })
    expect(text(await call(r))).toContain('relay-too-old')
    expect((r.client['lookupBuild'] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    const r2 = rig({ held: false, lookup: { kind: 'not-found' } })
    expect(text(await call(r2))).toContain('not-held')
  })

  it('names the session already recording', async () => {
    const r = rig()
    r.claim.mockImplementation(() => { throw new AlreadyRecordingError('other', 'rec-0') })
    const res = await call(r)
    expect(text(res)).toBe('start_recording failed: already-recording (session other) — stop_recording it first')
    expect(r.release).not.toHaveBeenCalled()
  })

  it('replies with the id, the size and both caps, and keeps the claim', async () => {
    const r = rig()
    const res = await call(r)
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(text(res))).toEqual({
      recordingId: 'rec-1', recording: true, width: 390, height: 844,
      segmentCapBytes: SEGMENT_CAP_BYTES, totalCapBytes: TOTAL_CAP_BYTES,
    })
    expect(r.release).not.toHaveBeenCalled()
  })

  it('adds previous only when the manager returned one', async () => {
    const r = rig()
    r.start.mockResolvedValue({ width: 1, height: 2, previous: { recordingId: 'old', pending: 2 } })
    expect(JSON.parse(text(await call(r)))['previous']).toEqual({ recordingId: 'old', pending: 2 })
  })

  it.each([
    [new NoKeyframeError(), 'start_recording failed: no-keyframe — no decodable keyframe arrived in 5 s; is the device booted and streaming?'],
    [new JpegStreamError(), 'start_recording failed: jpeg-stream — the device streams JPEG; call shutdown_device then boot_device so it boots with H.264'],
    [new StreamRefusedError('s1', 'not-session-owner', 'refused'), 'start_recording failed: stream-refused: not-session-owner'],
    [new StoppedBeforeKeyframeError(), 'start_recording failed: stopped before a keyframe'],
    [new Error('disk full'), 'start_recording failed: disk full'],
  ])('maps a failed start to prose (%#)', async (error, msg) => {
    const r = rig()
    r.start.mockRejectedValue(error)
    const res = await call(r)
    expect(text(res)).toBe(msg)
    expect(res.isError).toBe(true)
    expect(r.release).toHaveBeenCalledTimes(1)
  })
})

describe('stop_recording', () => {
  const call = (r: Rig, args: Record<string, unknown> = { sessionId: 's1' }) => r.handlers.get('stop_recording')!(args)

  it('waits 30 s by default, minus what the stop spent, and replies with the live status', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.stop.mockImplementation(async () => { vi.advanceTimersByTime(1_000); return {} })
    const res = await call(r)
    expect(r.awaitUploads).toHaveBeenCalledWith('rec-1', 29_000)
    expect(JSON.parse(text(res))).toEqual(r.status.mock.results[0]!.value)
    expect(r.status).toHaveBeenCalledWith('s1', 'rec-1')
  })

  it('clamps waitMs to 50 s', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.stop.mockImplementation(async () => { vi.advanceTimersByTime(1_000); return {} })
    await call(r, { sessionId: 's1', waitMs: 600_000 })
    expect(r.awaitUploads).toHaveBeenCalledWith('rec-1', 49_000)
  })

  it('a second stop, and a stop on an unknown session, answer not-recording', async () => {
    const r = rig()
    await call(r)
    const again = await call(r)
    expect(again.isError).toBe(true)
    expect(text(again)).toContain('not-recording')
    expect(text(await call(r, { sessionId: 'nope' }))).toContain('not-recording')
    expect(r.stop).toHaveBeenCalledTimes(1)
  })
})

describe('recording_status', () => {
  const call = (r: Rig, args: Record<string, unknown>) => r.handlers.get('recording_status')!(args)

  it('returns the status, or idle', async () => {
    const r = rig()
    expect(JSON.parse(text(await call(r, { sessionId: 's1' })))['recordingId']).toBe('rec-1')
    r.status.mockReturnValue(null)
    expect(JSON.parse(text(await call(r, { sessionId: 's1', recordingId: 'x' })))).toEqual({ state: 'idle' })
    expect(r.status).toHaveBeenLastCalledWith('s1', 'x')
  })
})

describe('the tool wrapper', () => {
  it('lets stop_recording and recording_status through a released session, but not install_app', async () => {
    // install_app needs the full register path; it must answer the note before touching the client.
    const r = rig({ released: 'the relay released this session' })
    const install = await r.handlers.get('install_app')!({ sessionId: 's1', buildId: 1 })
    expect(text(install)).toContain('the relay released this session')
    expect(r.client['installApp']).not.toHaveBeenCalled()
    expect(text(await r.handlers.get('stop_recording')!({ sessionId: 's1' }))).not.toContain('released')
    expect(r.stop).toHaveBeenCalled()
    await r.handlers.get('recording_status')!({ sessionId: 's1' })
    expect(r.status).toHaveBeenCalled()
  })

  it('resumes parked uploads once after a reconnect, and not otherwise', async () => {
    const r = rig()
    await r.handlers.get('recording_status')!({ sessionId: 's1' })
    expect(r.resumeParked).not.toHaveBeenCalled()
    ;(r.client['reconnectIfRotated'] as ReturnType<typeof vi.fn>).mockImplementation(async () => { (r.client as { reconnects: number }).reconnects++ })
    await r.handlers.get('recording_status')!({ sessionId: 's1' })
    expect(r.resumeParked).toHaveBeenCalledTimes(1)
  })
})

describe('createRecording', () => {
  it('hands the manager to the client as its recorder hooks', () => {
    const setRecorderHooks = vi.fn()
    const client = { setRecorderHooks, tokens: { token: 't', refresh: vi.fn() }, httpBase: () => 'http://relay' }
    const { manager } = createRecording(client as unknown as TapflowClient)
    expect(setRecorderHooks).toHaveBeenCalledWith(manager)
  })
})
