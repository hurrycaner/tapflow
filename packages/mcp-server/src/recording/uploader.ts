import { openAsBlob } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { fetchWithToken, tokenRefusal, type TokenSource } from '@tapflowio/flow-runner'
import type { UploadJob, UploadLane, UploadState } from './types.js'

/**
 * Deadline for one upload, in ms (C15): at least 60 s, and 1 s per 50 KB. The assumption is a slow tunnel at
 * roughly 400 kbit/s, which still finishes a 100 MB segment in ~2000 s instead of being cut off mid-body.
 */
export function uploadDeadlineMs(bytes: number): number {
  return Math.max(60_000, Math.ceil(bytes / (50 * 1024)) * 1000)
}

export interface UploaderDeps {
  tokens: TokenSource
  httpBase: string
  report: (recordingId: string, index: number, state: UploadState) => void
  fetchImpl?: typeof fetch
  /** Seam for tests. `type` must reach the Blob: without it the relay stores and serves application/octet-stream (V32). */
  openBlob?: (path: string, type: string) => Promise<Blob>
}

/**
 * One serial upload queue per process (C15). A file-backed Blob keeps a 100 MB segment out of RAM, which
 * a Buffer body across five segments would not.
 */
export class RecordingUploader implements UploadLane {
  private readonly queue: UploadJob[] = []
  private readonly parked: UploadJob[] = []
  /** Jobs that already met one 401 after being parked; a second one is final (no infinite park). */
  private readonly resumed = new Set<UploadJob>()
  private running = false
  private idleWaiters: Array<() => void> = []
  private readonly fetchImpl: typeof fetch
  private readonly openBlob: (path: string, type: string) => Promise<Blob>

  constructor(private readonly deps: UploaderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.openBlob = deps.openBlob ?? ((path, type) => openAsBlob(path, { type }))
  }

  get queued(): number { return this.queue.length }
  get parkedCount(): number { return this.parked.length }

  enqueue(job: UploadJob): void {
    this.safeReport(job, { state: 'pending' })
    this.queue.push(job)
    this.kick()
  }

  /** Re-queues every parked job once; called after a rotated token connects, or by the exit drain (C15). */
  resumeParked(): void {
    if (this.parked.length === 0) return
    for (const job of this.parked.splice(0)) {
      this.resumed.add(job)
      this.queue.push(job)
    }
    this.kick()
  }

  /** Resolves when the queue and the in-flight job are empty; parked jobs do not block it. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private kick(): void {
    if (this.running) return
    this.running = true
    void this.work()
  }

  private async work(): Promise<void> {
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        let state: UploadState
        try {
          state = await this.upload(job)
        } catch (err) {
          // V31: nothing escapes the loop; an unexpected throw is a failed segment, not a dead lane.
          state = failed(null, job, `upload failed (${message(err)})`)
        }
        if (state.state === 'pending') this.parked.push(job)
        else {
          this.resumed.delete(job)
          if (state.state === 'done') await rm(job.path, { force: true }).catch(() => {})
        }
        this.safeReport(job, state)
      }
    } finally {
      this.running = false
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }

  private async upload(job: UploadJob): Promise<UploadState> {
    const { httpBase, tokens } = this.deps
    const url = new URL('/api/v1/recordings/upload', httpBase)
    url.searchParams.set('sessionId', job.sessionId)
    url.searchParams.set('buildId', String(job.buildId))
    let res: Response
    try {
      const blob = await this.openBlob(job.path, 'video/mp4')
      const form = new FormData()
      form.append('file', blob, `tapflow-${Date.now()}-${job.index}.mp4`)
      res = await fetchWithToken(
        tokens,
        url.toString(),
        { method: 'POST', body: form, signal: AbortSignal.timeout(uploadDeadlineMs(job.bytes)) },
        this.fetchImpl,
      )
    } catch (err) {
      if (isAbort(err)) return failed(null, job, 'timeout')
      // #576: name the cause; a bare `TypeError: fetch failed` says nothing about what to fix.
      return failed(null, job, `could not reach the relay (${causeMessage(err)})`)
    }
    try {
      if (res.ok) {
        const body = (await res.json()) as { url?: unknown }
        if (typeof body.url !== 'string') return failed(res.status, job, 'the relay answered 200 without a url')
        // V12: the relay answers a path; the caller needs something it can open.
        return { state: 'done', url: new URL(body.url, httpBase).toString() }
      }
      const text = await errorText(res)
      if (res.status === 401) {
        if (this.resumed.has(job)) return failed(401, job, tokenRefusal(tokens))
        return { state: 'pending', reason: 'token' }
      }
      if (res.status === 403) return failed(403, job, `token lacks builds:write${text ? ` (${text})` : ''}`)
      return failed(res.status, job, `the relay answered ${res.status} ${text || res.statusText}`.trim())
    } catch (err) {
      if (isAbort(err)) return failed(null, job, 'timeout')
      return failed(res.status, job, `the relay's answer could not be read (${message(err)})`)
    }
  }

  private safeReport(job: UploadJob, state: UploadState): void {
    try {
      this.deps.report(job.recordingId, job.index, state)
    } catch (err) {
      process.stderr.write(`tapflow-mcp: recording ${basename(job.path)} state report failed: ${message(err)}\n`)
    }
  }
}

function failed(status: number | null, job: UploadJob, reason: string): UploadState {
  return { state: 'failed', status, tmpPath: job.path, reason }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function causeMessage(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined
  return cause === undefined ? message(err) : `${message(err)}: ${message(cause)}`
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  try {
    const j = JSON.parse(raw) as { error?: unknown; message?: unknown }
    const m = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : ''
    if (m) return m
  } catch { /* not JSON: use the raw text */ }
  return raw.slice(0, 200)
}
