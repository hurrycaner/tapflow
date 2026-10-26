import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixedToken, tokenRefusal } from '@tapflowio/flow-runner'
import type { UploadJob, UploadState } from '../recording/types.js'
import { RecordingUploader, uploadDeadlineMs } from '../recording/uploader.js'

const BASE = 'http://relay.test:4000'

interface Req { url: string; init: RequestInit }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uploader-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function job(index: number, bytes = 10): UploadJob {
  const path = join(dir, `seg-${index}.mp4`)
  writeFileSync(path, Buffer.alloc(bytes, index))
  return { recordingId: 'rec1', sessionId: 'sess/1', buildId: 7, index, path, bytes }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setup(script: Array<(req: Req) => Response | Promise<Response>>) {
  const reqs: Req[] = []
  const states: Array<{ index: number; state: UploadState }> = []
  const typeSpy = vi.fn()
  const tokens = fixedToken('tok', BASE)
  let n = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(url), init: init ?? {} }
    reqs.push(req)
    const step = script[Math.min(n++, script.length - 1)]!
    return step(req)
  }) as typeof fetch
  const up = new RecordingUploader({
    tokens,
    httpBase: BASE,
    report: (_r, index, state) => { states.push({ index, state }) },
    fetchImpl,
    openBlob: async (_path, type) => { typeSpy(type); return new Blob([new Uint8Array(4)], { type }) },
  })
  return { up, reqs, states, typeSpy, tokens }
}

const last = (s: Array<{ state: UploadState }>): UploadState => s[s.length - 1]!.state

describe('RecordingUploader', () => {
  it('reports pending synchronously and posts a multipart mp4 to the right URL', async () => {
    const { up, reqs, states, typeSpy } = setup([() => json(200, { url: '/api/v1/recordings/a.mp4' })])
    up.enqueue(job(3))
    expect(states).toEqual([{ index: 3, state: { state: 'pending' } }])
    await up.idle()
    const u = new URL(reqs[0]!.url)
    expect(u.origin + u.pathname).toBe(`${BASE}/api/v1/recordings/upload`)
    expect(u.searchParams.get('sessionId')).toBe('sess/1')
    expect(u.searchParams.get('buildId')).toBe('7')
    expect(typeSpy).toHaveBeenCalledWith('video/mp4')
    const form = await new Response(reqs[0]!.init.body as FormData).formData()
    const file = form.get('file') as File
    expect(file.name).toMatch(/^tapflow-\d+-3\.mp4$/)
    expect(file.type).toBe('video/mp4')
  })

  it('200 -> done with an absolute url, tmp removed', async () => {
    const { up, states } = setup([() => json(200, { url: '/api/v1/recordings/a.mp4' })])
    const j = job(0)
    up.enqueue(j)
    await up.idle()
    expect(last(states)).toEqual({ state: 'done', url: `${BASE}/api/v1/recordings/a.mp4` })
    expect(existsSync(j.path)).toBe(false)
  })

  it('uploads in enqueue order, one at a time', async () => {
    let release!: (r: Response) => void
    const { up, reqs } = setup([
      () => new Promise<Response>((res) => { release = res }),
      () => json(200, { url: '/x' }),
    ])
    up.enqueue(job(0)); up.enqueue(job(1))
    await vi.waitFor(() => expect(reqs).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(reqs).toHaveLength(1)
    release(json(200, { url: '/x' }))
    await up.idle()
    expect(reqs).toHaveLength(2)
    expect(up.queued).toBe(0)
  })

  it('401 parks as pending{token}; resumeParked retries; a second 401 fails with the token advice', async () => {
    const { up, reqs, states, tokens } = setup([() => json(401, { error: 'no' })])
    const j = job(0)
    up.enqueue(j)
    await up.idle()
    expect(last(states)).toEqual({ state: 'pending', reason: 'token' })
    expect(existsSync(j.path)).toBe(true)
    expect(up.parkedCount).toBe(1)
    expect(reqs).toHaveLength(1)
    up.resumeParked()
    await up.idle()
    expect(reqs).toHaveLength(2)
    expect(last(states)).toEqual({ state: 'failed', status: 401, tmpPath: j.path, reason: tokenRefusal(tokens) })
    expect(up.parkedCount).toBe(0)
  })

  it('401 then resume then 200 -> done', async () => {
    const { up, states } = setup([() => json(401, {}), () => json(200, { url: '/r.mp4' })])
    const j = job(0)
    up.enqueue(j)
    await up.idle()
    up.resumeParked()
    await up.idle()
    expect(last(states)).toEqual({ state: 'done', url: `${BASE}/r.mp4` })
    expect(existsSync(j.path)).toBe(false)
  })

  it('403 -> failed with the relay text, tmp kept', async () => {
    const { up, states } = setup([() => json(403, { error: 'scope missing' })])
    const j = job(0)
    up.enqueue(j)
    await up.idle()
    const s = last(states)
    expect(s).toMatchObject({ state: 'failed', status: 403, tmpPath: j.path })
    expect((s as { reason: string }).reason).toContain('token lacks builds:write')
    expect((s as { reason: string }).reason).toContain('scope missing')
    expect(existsSync(j.path)).toBe(true)
  })

  it('500 -> failed with status and text, tmp kept', async () => {
    const { up, states } = setup([() => new Response('boom', { status: 500, statusText: 'Internal' })])
    const j = job(0)
    up.enqueue(j)
    await up.idle()
    expect(last(states)).toMatchObject({ state: 'failed', status: 500, reason: 'the relay answered 500 boom' })
    expect(existsSync(j.path)).toBe(true)
  })

  it('a rejected fetch names its cause and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const { up, states } = setup([() => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }) }])
    up.enqueue(job(0))
    await up.idle()
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', unhandled)
    const s = last(states) as { status: number | null; reason: string }
    expect(s.status).toBeNull()
    expect(s.reason).toContain('could not reach the relay')
    expect(s.reason).toContain('ECONNREFUSED')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('an aborted request reports timeout; the deadline scales with bytes', async () => {
    const { up, states } = setup([
      (req) => new Promise<Response>((_res, rej) => {
        const sig = req.init.signal!
        sig.addEventListener('abort', () => rej(sig.reason))
      }),
    ])
    // AbortSignal.timeout runs on a native timer that fake timers do not reach, so shorten it instead.
    const real = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(20))
    try {
      const j = job(0, 10)
      up.enqueue(j)
      await up.idle()
      expect(spy).toHaveBeenCalledWith(60_000)
      expect(last(states)).toEqual({ state: 'failed', status: null, tmpPath: j.path, reason: 'timeout' })
      expect(existsSync(j.path)).toBe(true)
    } finally { spy.mockRestore() }
    expect(uploadDeadlineMs(1024 * 1024)).toBe(60_000)
    expect(uploadDeadlineMs(100 * 1024 * 1024)).toBeGreaterThanOrEqual(2_000_000)
  })

  it('idle resolves after the last report and is not blocked by parked jobs', async () => {
    const { up, states } = setup([() => json(401, {}), () => json(200, { url: '/x' })])
    await up.idle()
    up.enqueue(job(0))
    up.enqueue(job(1))
    await up.idle()
    expect(up.parkedCount).toBe(1)
    expect(last(states)).toEqual({ state: 'done', url: `${BASE}/x` })
  })
})
