import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RecordingManager } from '../recording/RecordingManager'
import { AlreadyRecordingError, StoppedBeforeKeyframeError } from '../recording/types'
import { T0, deltaFrame, keyFrame, makeHarness, settle, type HarnessOptions } from './recordingFixtures'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function managerFor(opts: HarnessOptions = {}) {
  const h = makeHarness(opts)
  const stderr: string[] = []
  const m = new RecordingManager({
    client: h.client, openSegment: h.openSegment, tmpDir: '/tmp', lane: h.lane,
    removeFile: h.removeFile, stderr: (l) => stderr.push(l),
  })
  return { h, m, stderr }
}

type M = ReturnType<typeof managerFor>

/** Starts a recording and primes it through the hook the client calls. */
async function startPrimed(x: M, sessionId: string, recordingId: string) {
  const started = x.m.start({ sessionId, buildId: 7, recordingId })
  await settle()
  x.m.onBinary(keyFrame(T0))
  return started
}

const togglesTrue = (x: M) => x.h.client.setStream.mock.calls.filter((c) => c[1] === true).length

describe('RecordingManager slot (C11, V8, V15)', () => {
  it('two concurrent starts → one AlreadyRecordingError naming the other session and recordingId', async () => {
    const x = managerFor()
    const a = x.m.start({ sessionId: 'sA', buildId: 1, recordingId: 'recA' })
    const b = x.m.start({ sessionId: 'sB', buildId: 1, recordingId: 'recB' })
    const err = await b.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(AlreadyRecordingError)
    expect(err).toMatchObject({ activeSessionId: 'sA', activeRecordingId: 'recA' })
    expect(x.h.client.setStream).not.toHaveBeenCalledWith('sB', expect.anything())
    await settle()
    x.m.onBinary(keyFrame(T0))
    await expect(a).resolves.toMatchObject({ width: 1280, height: 720 })
  })

  it('releases the slot after a failed start, and keeps no result for it', async () => {
    const x = managerFor({ openFails: (i) => i === 0 })
    await expect(x.m.start({ sessionId: 'sA', buildId: 1, recordingId: 'recA' })).rejects.toThrow(/EACCES/)
    expect(x.m.results.size).toBe(0)
    expect(x.m.status('sA')).toBeNull()
    const y = managerFor()
    const started = y.m.start({ sessionId: 'sA', buildId: 1, recordingId: 'recB' })
    await settle()
    y.m.onBinary(keyFrame(T0))
    await started

    // A stop before a keyframe is a failed start as well.
    const z = managerFor()
    const pending = z.m.start({ sessionId: 'sA', buildId: 1, recordingId: 'recC' })
    const rejected = expect(pending).rejects.toBeInstanceOf(StoppedBeforeKeyframeError)
    await settle()
    await z.m.activeRecorder()!.stop()
    await rejected
    expect(z.m.isActive('sA')).toBe(false)
    const again = z.m.start({ sessionId: 'sB', buildId: 1, recordingId: 'recD' })
    await settle()
    z.m.onBinary(keyFrame(T0))
    await again
  })

  it('finalizing frees the slot: a new start is accepted once the old one stopped', async () => {
    const x = managerFor()
    const first = await startPrimed(x, 'sA', 'recA')
    await first.recorder.stop()
    const second = x.m.start({ sessionId: 'sB', buildId: 1, recordingId: 'recB' })
    await settle()
    x.m.onBinary(keyFrame(T0))
    await expect(second).resolves.toBeDefined()
  })
})

describe('RecordingManager results (V18)', () => {
  it('reports previous when the prior result has pending > 0, never drops it, and drops it once uploaded', async () => {
    const x = managerFor()
    const first = await startPrimed(x, 'sA', 'recA')
    await first.recorder.stop()
    expect(first.previous).toBeUndefined()
    expect(x.m.status('sA')).toMatchObject({ recordingId: 'recA', state: 'uploading', pending: 1 })

    const second = await startPrimed(x, 'sA', 'recB')
    expect(second.previous).toEqual({ recordingId: 'recA', pending: 1 })
    expect(x.m.results.has('recA')).toBe(true) // a new start never detaches a result with pending > 0
    expect(x.m.status('sA', 'recA')).toMatchObject({ pending: 1 })
    expect(x.m.status('sA')?.recordingId).toBe('recB')

    x.m.setUploadState('recA', 0, { state: 'done', url: 'http://relay/a.mp4' })
    expect(x.m.results.has('recA')).toBe(false) // pending 0 and no longer the latest
    expect(x.m.status('sA', 'recA')).toBeNull()
  })

  it('setUploadState drives pending to 0 and flips uploading → done; the latest result stays readable', async () => {
    const x = managerFor()
    const s = await startPrimed(x, 'sA', 'recA')
    await s.recorder.stop()
    expect(x.m.status('sA')).toMatchObject({ state: 'uploading', pending: 1 })
    x.m.setUploadState('recA', 0, { state: 'pending', reason: 'token' })
    expect(x.m.status('sA')).toMatchObject({ state: 'uploading', pending: 1 })
    x.m.setUploadState('recA', 0, { state: 'done', url: 'http://relay/a.mp4' })
    expect(x.m.status('sA')).toMatchObject({
      state: 'done', pending: 0, segments: [{ upload: { state: 'done', url: 'http://relay/a.mp4' } }],
    })
  })

  it('a failed upload is not pending', async () => {
    const x = managerFor()
    const s = await startPrimed(x, 'sA', 'recA')
    await s.recorder.stop()
    x.m.setUploadState('recA', 0, { state: 'failed', status: 403, tmpPath: '/tmp/x.mp4', reason: 'token lacks builds:write' })
    expect(x.m.status('sA')).toMatchObject({ state: 'done', pending: 0 })
  })

  it('awaitUploads resolves at pending 0 or after ms', async () => {
    const x = managerFor()
    const s = await startPrimed(x, 'sA', 'recA')
    await s.recorder.stop()
    let done = false
    const waiting = x.m.awaitUploads('recA', 30_000).then(() => { done = true })
    await settle(10_000)
    expect(done).toBe(false)
    x.m.setUploadState('recA', 0, { state: 'done', url: 'u' })
    await waiting
    expect(done).toBe(true)

    const y = managerFor()
    const s2 = await startPrimed(y, 'sA', 'recB')
    await s2.recorder.stop()
    const bounded = y.m.awaitUploads('recB', 2_000)
    await settle(2_000)
    await bounded
    expect(y.m.status('sA')?.pending).toBe(1)
  })
})

describe('RecordingManager hooks (C2b, C12, V24, V26)', () => {
  it('onJoined re-sends setStream(true) only for the active recorder session, and only while active', async () => {
    const x = managerFor()
    const s = await startPrimed(x, 'sA', 'recA')
    const base = togglesTrue(x)
    x.m.onJoined('sB')
    await settle()
    expect(togglesTrue(x)).toBe(base)
    x.m.onJoined('sA')
    await settle()
    expect(togglesTrue(x)).toBe(base + 1)
    await s.recorder.stop()
    x.m.onJoined('sA')
    await settle()
    expect(togglesTrue(x)).toBe(base + 1)
  })

  it('isActive and onBinary address the active recorder only', async () => {
    const x = managerFor()
    expect(x.m.isActive('sA')).toBe(false)
    const s = await startPrimed(x, 'sA', 'recA')
    expect(x.m.isActive('sA')).toBe(true)
    expect(x.m.isActive('sB')).toBe(false)
    x.m.onBinary(deltaFrame(T0 + 33))
    expect(x.h.writers[0]!.adds).toHaveLength(2)
    await s.recorder.stop()
    expect(x.m.isActive('sA')).toBe(false)
    x.m.onBinary(deltaFrame(T0 + 66))
    expect(x.h.writers[0]!.adds).toHaveLength(2)
  })

  it('onTerminated cuts the matching session short, finalizing before the toggle', async () => {
    const x = managerFor()
    await startPrimed(x, 'sA', 'recA')
    x.m.onTerminated('sB')
    await settle()
    expect(x.m.isActive('sA')).toBe(true)
    x.m.onTerminated('sA')
    await settle()
    expect(x.m.status('sA')).toMatchObject({ endReason: 'cut-short', pending: 1 })
    expect(x.h.log.slice(-3)).toEqual(['finalize:0', 'lane:0', 'toggle:false'])
  })

  it('onClose cuts short before anything else; the toggle is attempted only while held', async () => {
    const held = managerFor()
    await startPrimed(held, 'sA', 'recA')
    held.m.onClose()
    await settle()
    expect(held.m.status('sA')?.endReason).toBe('cut-short')
    expect(held.h.log.slice(-3)).toEqual(['finalize:0', 'lane:0', 'toggle:false'])

    const gone = managerFor()
    await startPrimed(gone, 'sA', 'recA')
    gone.h.state.held = false
    gone.m.onClose()
    await settle()
    expect(gone.m.status('sA')?.endReason).toBe('cut-short')
    expect(gone.h.client.setStream.mock.calls.filter((c) => c[1] === false)).toHaveLength(0)
  })

  it('hooks do not throw with nothing recording', () => {
    const x = managerFor()
    expect(() => { x.m.onBinary(keyFrame()); x.m.onJoined('s'); x.m.onTerminated('s'); x.m.onClose() }).not.toThrow()
  })
})

describe('RecordingManager.drainForExit (V22, V31)', () => {
  it('cuts the active recorder short, waits at most ms, and prints segments that did not upload', async () => {
    const x = managerFor()
    await startPrimed(x, 'sA', 'recA')
    const drained = x.m.drainForExit(1_000)
    await settle(1_000)
    await drained
    expect(x.m.status('sA')?.endReason).toBe('cut-short')
    expect(x.stderr).toEqual(['tapflow-rec kept: /tmp/tapflow-rec-recA-0.mp4'])
  })

  it('returns as soon as uploads are done and prints nothing', async () => {
    const x = managerFor()
    await startPrimed(x, 'sA', 'recA')
    const drained = x.m.drainForExit(10_000)
    await settle()
    x.m.setUploadState('recA', 0, { state: 'done', url: 'u' })
    await drained
    expect(x.stderr).toEqual([])
  })

  it('is bounded even when finalize never settles, and names the open file', async () => {
    const never = { promise: new Promise<void>(() => undefined), open: () => undefined }
    const x = managerFor({ finalizeGate: () => never })
    await startPrimed(x, 'sA', 'recA')
    const drained = x.m.drainForExit(500)
    await settle(500)
    await drained
    expect(x.stderr).toEqual(['tapflow-rec kept: /tmp/tapflow-rec-recA-0.mp4'])
  })

  it('prints the tmpPath of a failed upload', async () => {
    const x = managerFor()
    const s = await startPrimed(x, 'sA', 'recA')
    await s.recorder.stop()
    x.m.setUploadState('recA', 0, { state: 'failed', status: null, tmpPath: '/tmp/kept.mp4', reason: 'timeout' })
    await x.m.drainForExit(100)
    expect(x.stderr).toEqual(['tapflow-rec kept: /tmp/kept.mp4'])
  })

  it('with nothing recording it resolves immediately', async () => {
    const x = managerFor()
    await x.m.drainForExit(10_000)
    expect(x.stderr).toEqual([])
  })
})
