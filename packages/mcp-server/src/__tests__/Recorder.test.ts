import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'
import { StreamRefusedError } from '../client'
import { Recorder, type RecorderDeps } from '../recording/Recorder'
import { Mp4Segment } from '../recording/mp4'
import {
  JpegStreamError,
  NoKeyframeError,
  StoppedBeforeKeyframeError,
  type RecordingResult,
} from '../recording/types'
import {
  T0, SPS_PORTRAIT, audioFrame, bigKey, deltaFrame, gate, hugeDelta, jpegFrame, keyFrame, keyNoSps,
  makeHarness, settle, type HarnessOptions,
} from './recordingFixtures'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

type H = ReturnType<typeof makeHarness>

function recorderFor(h: H, over: Partial<RecorderDeps> = {}): Recorder {
  return new Recorder({
    recordingId: 'rec1', sessionId: 's1', buildId: 7, tmpDir: '/tmp',
    client: h.client, openSegment: h.openSegment, lane: h.lane, removeFile: h.removeFile, ...over,
  })
}

/** Starts a recorder and feeds the first decodable key so it is `recording`. */
async function primed(opts: HarnessOptions = {}) {
  const h = makeHarness(opts)
  const r = recorderFor(h)
  const started = r.start()
  await settle()
  r.onFrame(keyFrame(T0))
  await started
  return { h, r }
}

const togglesTrue = (h: H) => h.client.setStream.mock.calls.filter((c) => c[1] === true).length
const togglesFalse = (h: H) => h.client.setStream.mock.calls.filter((c) => c[1] === false).length

describe('Recorder start (C4, C6, C8, V19, V27)', () => {
  it('opens segment 0 and awaits it before the first toggle; an unwritable open rejects with no toggle', async () => {
    const h = makeHarness()
    const r = recorderFor(h)
    const started = r.start()
    await settle()
    expect(h.log.slice(0, 2)).toEqual(['open:0', 'toggle:true'])
    r.onFrame(keyFrame())
    await expect(started).resolves.toEqual({ width: 1280, height: 720 })

    const bad = makeHarness({ openFails: () => true })
    const r2 = recorderFor(bad)
    await expect(r2.start()).rejects.toThrow(/EACCES/)
    expect(bad.client.setStream).not.toHaveBeenCalled()
    expect(r2.isActive()).toBe(false)
  })

  it('re-sends setStream(true) every 600 ms until the decodable key, never after; the timer is dead before the exit toggle on stop', async () => {
    const h = makeHarness()
    const r = recorderFor(h)
    const started = r.start()
    await settle()
    expect(togglesTrue(h)).toBe(1)
    await settle(600 * 3)
    expect(togglesTrue(h)).toBe(4)
    r.onFrame(keyFrame())
    await started
    await settle(5_000)
    expect(togglesTrue(h)).toBe(4)

    // V19 + V23: stop while re-priming with the old segment still finalizing; the loop must not outlive the stop call.
    const g = gate()
    const { r: r2, h: h2 } = await primed({ finalizeGate: () => g })
    r2.onFrame(hugeDelta())
    await settle()
    expect(r2.result().state).toBe('re-priming')
    await settle(1_200)
    const before = togglesTrue(h2)
    expect(before).toBeGreaterThan(1)
    const stopping = r2.stop()
    await settle(2_400)
    expect(togglesTrue(h2)).toBe(before)
    g.open()
    await stopping
    expect(h2.log.at(-1)).toBe('toggle:false')
  })

  it('times out at 5 s with NoKeyframeError, sends stream:false once, removes the tmp file, keeps no segment', async () => {
    const h = makeHarness()
    const r = recorderFor(h)
    const started = r.start()
    const rejected = expect(started).rejects.toBeInstanceOf(NoKeyframeError)
    await settle(5_000)
    await rejected
    expect(togglesFalse(h)).toBe(1)
    expect(h.removed).toEqual(['/tmp/tapflow-rec-rec1-0.mp4'])
    expect(h.jobs).toEqual([])
    expect(r.result()).toMatchObject({ state: 'done', segments: [], pending: 0 })
  })

  it('a JPEG frame while priming rejects with JpegStreamError, toggles off and removes the tmp file', async () => {
    const h = makeHarness()
    const r = recorderFor(h)
    const started = r.start()
    const rejected = expect(started).rejects.toBeInstanceOf(JpegStreamError)
    await settle()
    r.onFrame(jpegFrame())
    await rejected
    expect(togglesFalse(h)).toBe(1)
    expect(h.removed).toEqual(['/tmp/tapflow-rec-rec1-0.mp4'])
    expect(r.isActive()).toBe(false)
    await settle(10_000)
    expect(togglesTrue(h)).toBe(1) // the timer died with the failure
  })

  it('a refusal of the first toggle propagates as-is and leaves no tmp file or stream-off', async () => {
    const h = makeHarness()
    const refusal = new StreamRefusedError('s1', 'session-not-found', 'no such session')
    h.client.setStream.mockRejectedValueOnce(refusal)
    const r = recorderFor(h)
    await expect(r.start()).rejects.toBe(refusal)
    expect(togglesFalse(h)).toBe(0)
    expect(h.removed).toEqual(['/tmp/tapflow-rec-rec1-0.mp4'])
  })

  it('stop during priming makes start reject StoppedBeforeKeyframeError and returns no segments', async () => {
    const h = makeHarness()
    const r = recorderFor(h)
    const started = r.start()
    const rejected = expect(started).rejects.toBeInstanceOf(StoppedBeforeKeyframeError)
    await settle()
    const res = await r.stop()
    await rejected
    expect(res).toMatchObject({ segments: [], endReason: 'stopped', state: 'done' })
    expect(togglesFalse(h)).toBe(1)
    expect(h.removed).toEqual(['/tmp/tapflow-rec-rec1-0.mp4'])
  })
})

describe('Recorder frames (V3, V9, V11, C10)', () => {
  it('adds the key and deltas; ignores audio, JPEG and everything after stop; a key without SPS is not a rollover', async () => {
    const { h, r } = await primed()
    r.onFrame(deltaFrame(T0 + 33))
    r.onFrame(audioFrame(T0 + 40))
    r.onFrame(jpegFrame(T0 + 41))
    r.onFrame(keyNoSps(T0 + 66))
    r.onFrame(Buffer.from('not an envelope'))
    expect(h.writers).toHaveLength(1)
    expect(h.writers[0]!.adds.map((a) => a.capturedAt)).toEqual([T0, T0 + 33, T0 + 66])
    expect(r.result().state).toBe('recording')

    await r.stop()
    r.onFrame(deltaFrame(T0 + 99))
    expect(h.writers[0]!.adds).toHaveLength(3)
  })

  it('a dims change on a keyframe with SPS finalizes the old segment before the new one takes its first add', async () => {
    const g = gate()
    const { h, r } = await primed({ finalizeGate: (i) => (i === 0 ? g : undefined) })
    r.onFrame(deltaFrame(T0 + 33))
    r.onFrame(keyFrame(T0 + 66, SPS_PORTRAIT))
    await settle()
    expect(r.result().state).toBe('rolling')
    expect(h.writers[1]?.adds ?? []).toEqual([]) // finalize(0) has not settled, so segment 1 takes nothing yet
    expect(h.jobs).toEqual([])
    g.open()
    await settle()
    expect(h.log.indexOf('finalize:0')).toBeLessThan(h.log.indexOf('add:1'))
    expect(h.jobs.map((j) => j.index)).toEqual([0])
    expect(h.writers[1]!.adds.map((a) => a.capturedAt)).toEqual([T0 + 66])
    expect(h.writers[1]!.adds[0]!.dims).toEqual({ width: 720, height: 1280 })
    expect(r.result().state).toBe('recording')
    expect(r.result().segments.map((s) => s.index)).toEqual([0])
  })

  it('frames that arrive while the next file opens are buffered and added after the first add, in order', async () => {
    const g = gate()
    const { h, r } = await primed({ finalizeGate: (i) => (i === 0 ? g : undefined) })
    r.onFrame(keyFrame(T0 + 66, SPS_PORTRAIT))
    r.onFrame(deltaFrame(T0 + 99))
    g.open()
    await settle()
    expect(h.writers[1]!.adds.map((a) => a.capturedAt)).toEqual([T0 + 66, T0 + 99])
  })
})

describe('Recorder rollover and caps (C9, V5, V25)', () => {
  it('a delta that would cross the cap is dropped, enters re-priming and re-sends every 600 ms; the next decodable key opens segment 1', async () => {
    const { h, r } = await primed()
    const before = togglesTrue(h)
    r.onFrame(hugeDelta())
    await settle()
    expect(r.result().state).toBe('re-priming')
    expect(h.writers[0]!.adds).toHaveLength(1) // the oversized delta was not muxed
    expect(h.jobs.map((j) => j.index)).toEqual([0])
    await settle(1_800)
    expect(togglesTrue(h) - before).toBe(3)
    r.onFrame(deltaFrame(T0 + 500)) // still no key: dropped
    expect(h.writers).toHaveLength(1)
    r.onFrame(keyFrame(T0 + 600))
    await settle()
    expect(h.writers).toHaveLength(2)
    expect(h.writers[1]!.adds.map((a) => a.capturedAt)).toEqual([T0 + 600])
    expect(r.result().state).toBe('recording')
    await settle(5_000)
    expect(togglesTrue(h) - before).toBe(3) // loop stopped when the key arrived
  })

  it('a decodable key that crosses the cap is the new segment first add', async () => {
    const { h, r } = await primed()
    r.onFrame(bigKey())
    r.onFrame(bigKey()) // 2 x 60 MB > 100 MB
    await settle()
    expect(h.writers).toHaveLength(2)
    expect(h.writers[0]!.adds).toHaveLength(2)
    expect(h.writers[1]!.adds).toHaveLength(1)
    expect(h.writers[1]!.adds[0]!.decodableKey).toBe(true)
    expect(r.result().state).toBe('recording')
  })

  it('re-priming gives up at 30 s: endReason no-keyframe, the prior segment stays in the lane', async () => {
    const { h, r } = await primed()
    r.onFrame(hugeDelta())
    await settle(29_999)
    expect(r.result().state).toBe('re-priming')
    await settle(1)
    expect(r.result()).toMatchObject({ endReason: 'no-keyframe', state: 'uploading', pending: 1 })
    expect(h.jobs.map((j) => j.index)).toEqual([0])
    expect(h.log.at(-1)).toBe('toggle:false')
    expect(r.isActive()).toBe(false)
  })

  it('the 500 MB ceiling ends the recording with size-limit', async () => {
    const { h, r } = await primed()
    for (let i = 0; i < 9; i++) {
      r.onFrame(bigKey())
      await settle()
    }
    expect(r.result().endReason).toBe('size-limit')
    expect(r.isActive()).toBe(false)
    expect(h.log.at(-1)).toBe('toggle:false')
    // Every segment that finalized went to the lane in capture order.
    expect(h.jobs.map((j) => j.index)).toEqual(h.jobs.map((_, i) => i))
    expect(h.jobs.length).toBeGreaterThanOrEqual(4)
  })
})

describe('Recorder write errors (C9, V30)', () => {
  it('a finalize rejection ends with write-error, marks the segment, enqueues nothing for it and removes its tmp file', async () => {
    const { h, r } = await primed({ finalizeFails: (i) => i === 0 })
    r.onFrame(keyFrame(T0 + 66, SPS_PORTRAIT))
    await settle()
    const res = r.result()
    expect(res.endReason).toBe('write-error')
    expect(res.segments).toHaveLength(1)
    expect(res.segments[0]).toMatchObject({ index: 0, error: 'ENOSPC' })
    expect(res.segments[0]!.upload).toBeUndefined()
    expect(res.pending).toBe(0)
    expect(res.state).toBe('done')
    expect(h.jobs).toEqual([])
    expect(h.removed).toEqual(['/tmp/tapflow-rec-rec1-0.mp4'])
    expect(h.writers).toHaveLength(1) // the next file was never opened
    expect(h.log.at(-1)).toBe('toggle:false')
  })
})

describe('Recorder stop and cut-short (V17, V23, V26)', () => {
  it('stop finalizes, hands the segment to the lane, then toggles off', async () => {
    const { h, r } = await primed()
    r.onFrame(deltaFrame(T0 + 33))
    const res = await r.stop()
    expect(h.log.slice(-3)).toEqual(['finalize:0', 'lane:0', 'toggle:false'])
    expect(res).toMatchObject({ endReason: 'stopped', state: 'uploading', pending: 1 })
    expect(res.segments[0]).toMatchObject({ index: 0, bytes: 1000, upload: { state: 'pending' } })
  })

  it('a refused or failing exit toggle is noted and never changes the result', async () => {
    const { h, r } = await primed()
    h.client.setStream.mockRejectedValueOnce(new StreamRefusedError('s1', 'session-not-found', 'gone'))
    const res = await r.stop()
    expect(res.endReason).toBe('stopped')
    expect(res.segments).toHaveLength(1)
    expect(res.toggleNote).toMatch(/gone/)

    const { h: h2, r: r2 } = await primed()
    h2.client.setStream.mockImplementationOnce(() => { throw new Error('socket is closed') })
    const res2 = await r2.cutShort('socket-closed')
    expect(res2).toMatchObject({ endReason: 'cut-short', segments: [{ index: 0 }] })
    expect(res2.toggleNote).toMatch(/socket is closed/)
  })

  it('sends no toggle when the session is no longer held', async () => {
    const { h, r } = await primed()
    h.state.held = false
    const before = h.client.setStream.mock.calls.length
    const res = await r.stop()
    expect(h.client.setStream.mock.calls.length).toBe(before)
    expect(res.segments).toHaveLength(1)
    expect(res.toggleNote).toBeUndefined()
  })

  it('stop concurrent with cutShort shares one finalize, one lane job and one toggle', async () => {
    const g = gate()
    const { h, r } = await primed({ finalizeGate: () => g })
    const a = r.stop()
    const b = r.cutShort('disconnect')
    g.open()
    const [ra, rb] = await Promise.all([a, b])
    expect(h.writers[0]!.finalize).toHaveBeenCalledTimes(1)
    expect(h.jobs).toHaveLength(1)
    expect(togglesFalse(h)).toBe(1)
    expect(ra).toEqual(rb)
    expect(ra.endReason).toBe('stopped') // the first caller's reason wins
  })

  it('a stop that lands while the next file opens still finalizes both segments', async () => {
    const g = gate()
    const { h, r } = await primed({ finalizeGate: (i) => (i === 0 ? g : undefined) })
    r.onFrame(keyFrame(T0 + 66, SPS_PORTRAIT))
    const stopping = r.stop()
    g.open()
    const res = await stopping
    expect(res.segments.map((s) => s.index)).toEqual([0, 1])
    expect(h.writers[1]!.adds).toHaveLength(1)
  })

  it('onFrame never throws, even when the writer does', async () => {
    const { h, r } = await primed()
    h.writers[0]!.add = () => { throw new Error('boom') }
    expect(() => r.onFrame(deltaFrame(T0 + 33))).not.toThrow()
    await settle()
    expect(r.result().endReason).toBe('write-error')
  })
})

describe('Recorder with the real Mp4Segment', () => {
  it('key + deltas → stop → a lane job with bytes > 0 and a file that parses', async () => {
    vi.useRealTimers()
    const dir = await mkdtemp(join(tmpdir(), 'recorder-int-'))
    try {
      const h = makeHarness()
      const r = recorderFor(h, { tmpDir: dir, openSegment: (p) => Mp4Segment.open(p) })
      const started = r.start()
      // Real I/O: wait for the toggle instead of faking time.
      await vi.waitFor(() => expect(h.client.setStream).toHaveBeenCalled())
      r.onFrame(keyFrame(T0))
      for (let i = 1; i <= 5; i++) r.onFrame(deltaFrame(T0 + i * 33))
      await started
      const res: RecordingResult = await r.stop()
      expect(h.jobs).toHaveLength(1)
      const job = h.jobs[0]!
      expect(job.bytes).toBeGreaterThan(0)
      expect((await stat(job.path)).size).toBe(job.bytes)
      expect(res.segments[0]).toMatchObject({ width: 1280, height: 720 })

      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(job.path) })
      const track = await input.getPrimaryVideoTrack()
      expect(track?.codedWidth).toBe(1280)
      let packets = 0
      for await (const _p of new EncodedPacketSink(track!).packets()) packets++
      expect(packets).toBe(6)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
