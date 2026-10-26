import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TapflowClient } from '../client.js'
import { registerTools } from '../tools.js'
import { RecordingManager } from '../recording/RecordingManager.js'
import { RecordingUploader } from '../recording/uploader.js'
import { Mp4Segment } from '../recording/mp4.js'
import { T0, keyFrame, deltaFrame } from './recordingFixtures.js'

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>
const text = (r: ToolResult) => r.content[0]?.text ?? ''

/** A minimal relay stub: joins a session, advertises `holder-stream`, acks the stream toggle, and pushes
 * two real H.264 frames (annexb fixtures) once streaming turns on — just enough for a real Recorder to
 * prime and finalize through the real client, with no mock socket standing in for either side. */
function fakeRelay(): { port: number; streamLog: boolean[]; close: () => Promise<void> } {
  const wss = new WebSocketServer({ port: 0 })
  const streamLog: boolean[] = []
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(String(data)) as Record<string, unknown> } catch { return }
      if (msg['type'] === 'agents:list') {
        ws.send(JSON.stringify({ type: 'agents:listed', sessions: [], features: ['holder-stream'] }))
      } else if (msg['type'] === 'session:start') {
        ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'] }))
      } else if (msg['type'] === 'session:stream') {
        streamLog.push(msg['stream'] as boolean)
        ws.send(JSON.stringify({ type: 'session:stream-set', sessionId: msg['sessionId'], stream: msg['stream'] }))
        if (msg['stream']) { ws.send(keyFrame(T0)); ws.send(deltaFrame(T0 + 33)) }
      }
    })
  })
  const port = (wss.address() as { port: number }).port
  return { port, streamLog, close: () => new Promise((resolve) => wss.close(() => resolve())) }
}

describe('recording e2e', () => {
  it('start_recording -> frames -> stop_recording uploads through the real client and a real ws relay', async () => {
    const relay = fakeRelay()
    const dir = await mkdtemp(join(tmpdir(), 'recording-e2e-'))
    const client = new TapflowClient(`ws://localhost:${relay.port}`, 'tflw_pat_test')
    const uploadedSessions: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (url.pathname.startsWith('/api/v1/builds/')) {
        return new Response(JSON.stringify({ bundle_id: 'com.example.app' }), { status: 200 })
      }
      if (url.pathname === '/api/v1/recordings/upload') {
        expect(init?.method).toBe('POST')
        uploadedSessions.push(url.searchParams.get('sessionId') ?? '')
        return new Response(JSON.stringify({ url: '/api/v1/recordings/x.mp4' }), { status: 200 })
      }
      throw new Error(`fakeFetch: unexpected request ${url.pathname}`)
    }
    vi.stubGlobal('fetch', fetchImpl)

    try {
      await client.connect()
      // eslint-disable-next-line prefer-const -- assigned once, after `uploader`'s report closure needs it (recording/index.ts does the same).
      let manager!: RecordingManager
      const uploader = new RecordingUploader({
        tokens: client.tokens, httpBase: client.httpBase(),
        report: (id, index, state) => manager.setUploadState(id, index, state),
      })
      manager = new RecordingManager({ client, openSegment: Mp4Segment.open, tmpDir: dir, lane: uploader })
      client.setRecorderHooks(manager)

      const handlers = new Map<string, Handler>()
      const server = { registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h) }
      registerTools(server as unknown as McpServer, client, { manager, uploader })

      expect((await handlers.get('connect_device')!({ sessionId: 'sess-e2e' })).isError).toBeFalsy()
      const started = await handlers.get('start_recording')!({ sessionId: 'sess-e2e', buildId: 7 })
      expect(started.isError).toBeFalsy()
      const { recordingId } = JSON.parse(text(started)) as { recordingId: string }

      const stopped = await handlers.get('stop_recording')!({ sessionId: 'sess-e2e', waitMs: 5000 })
      expect(stopped.isError).toBeFalsy()
      const result = JSON.parse(text(stopped)) as {
        endReason: string
        segments: Array<{ upload?: { state: string; url?: string } }>
      }
      expect(result.endReason).toBe('stopped')
      expect(result.segments[0]?.upload).toMatchObject({ state: 'done' })
      expect(result.segments[0]?.upload?.url).toMatch(/^https?:\/\//)
      expect(relay.streamLog).toEqual([true, false])
      expect(uploadedSessions).toEqual(['sess-e2e'])
      expect(existsSync(join(dir, `tapflow-rec-${recordingId}-0.mp4`))).toBe(false)
    } finally {
      client.disconnect()
      await relay.close()
      await rm(dir, { recursive: true, force: true })
      vi.unstubAllGlobals()
    }
  })
})
