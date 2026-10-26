import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { signJwt } from '../middleware/auth'
import { initDb, closeDb, getDb } from '../db'
import { barrier, waitForOpen, waitForType } from '@tapflowio/test-utils'
import type {
  AgentRegistered, AgentsListed, GenericError, SessionJoined,
  SessionStreamRefused, SessionStreamSet, WatchRefused,
} from '@tapflowio/protocol'

const { RelayServer } = await import('../RelayServer')
const { writeEnvelopeHeader } = await import('@tapflowio/agent-core/utils')

/**
 * **The holder turns its own frame delivery on and off after joining** (`session:stream`). The toggle moves
 * `holderStream`, which gates relay-to-holder forwarding and nothing else.
 */
describe('session:stream', () => {
  let server: InstanceType<typeof RelayServer>
  let port: number
  let tmpDir: string
  const GRACE = 150

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-watchers-'))
    initDb(path.join(tmpDir, 'test.db'))
    for (const id of [1, 2]) {
      getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'QA', 'x')").run(id, `u${id}@example.test`)
    }
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })

  beforeEach(async () => {
    server = new RelayServer({ port: 0, agentGraceMs: GRACE })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  /** `name` must differ between agents in one test: the same name re-registering is a restart, and the
   *  relay rebinds the first agent's session to it. */
  async function registerAgent(name = 'mac') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name,
      devices: [{ id: 'dev0', name: 'iPhone', platform: 'ios', status: 'shutdown' }],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions[0]!.sessionId
    const stream = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(stream)
    stream.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForType(stream, 'stream:registered')
    const fromAgent: Record<string, unknown>[] = []
    agent.on('message', (d, isBinary) => { if (!isBinary) fromAgent.push(JSON.parse(d.toString())) })
    return { agent, stream, sessionId, fromAgent }
  }

  /** `userId` signs a cookie — the credential that may watch. Without one this is a loopback socket with
   *  no credential, which is what a local MCP server is. */
  async function socket(client?: string, userId?: number) {
    const url = new URL(`ws://localhost:${port}`)
    if (client) url.searchParams.set('client', client)
    const headers = userId === undefined
      ? undefined
      : { cookie: `tapflow_token=${signJwt({ userId, email: `u${userId}@example.test`, role: 'QA' })}` }
    const ws = new WebSocket(url.toString(), { headers })
    const binary: Buffer[] = []
    ws.on('message', (d, isBinary) => { if (isBinary) binary.push(d as Buffer) })
    await waitForOpen(ws)
    return Object.assign(ws, { binary })
  }

  async function watch(ws: WebSocket, sessionId: string) {
    ws.send(JSON.stringify({ type: 'watch:start', sessionId }))
    const started = waitForType(ws, 'watch:started')
    const refused = waitForType<WatchRefused>(ws, 'watch:refused')
    return Promise.race([started.then(() => null), refused])
  }

  const jpeg = () => writeEnvelopeHeader(Buffer.from([0xff, 0xd8]), Date.now())

  /** Send a frame, and wait until it has reached `first`. The relay writes one frame to every recipient
   *  in the same turn, so after that a round-trip on any other recipient (`settle`) proves its copy — or
   *  the absence of one — has already been decided. */
  async function frame(stream: WebSocket, buf: Buffer, first: WebSocket & { binary: Buffer[] }) {
    const before = first.binary.length
    stream.send(buf)
    const deadline = Date.now() + 2000
    while (first.binary.length === before) {
      if (Date.now() > deadline) throw new Error('frame never reached the first recipient')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  async function settle(...sockets: WebSocket[]) { for (const s of sockets) await barrier(s) }

  // X1: a holder that does not read the stream asks for none (`stream: false`), and watchers are unaffected.
  async function joinWithoutStream(ws: WebSocket, sessionId: string, clientKind: 'mcp' | 'flow-runner' = 'mcp') {
    ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind, stream: false }))
    return waitForType<SessionJoined>(ws, 'session:joined')
  }


  async function setStream(ws: WebSocket, sessionId: string, value: boolean) {
    ws.send(JSON.stringify({ type: 'session:stream', sessionId, stream: value }))
    const set = waitForType<SessionStreamSet>(ws, 'session:stream-set')
    const refused = waitForType<SessionStreamRefused>(ws, 'session:stream-refused')
    return Promise.race([set, refused])
  }

  const idrRequests = (fromAgent: Record<string, unknown>[]) =>
    fromAgent.filter((m) => m['type'] === 'stream:request-idr').length

  it('starts and stops the holder\'s frames on request, and leaves a watcher alone throughout', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)

    await frame(stream, jpeg(), viewer)
    await settle(mcp)
    expect(mcp.binary).toHaveLength(0)

    expect(await setStream(mcp, sessionId, true)).toMatchObject({ type: 'session:stream-set', sessionId, stream: true })
    await frame(stream, jpeg(), mcp)
    await settle(viewer)
    expect(mcp.binary).toHaveLength(1)
    expect(viewer.binary).toHaveLength(2)

    expect(await setStream(mcp, sessionId, false)).toMatchObject({ type: 'session:stream-set', sessionId, stream: false })
    await frame(stream, jpeg(), viewer)
    await settle(mcp)
    expect(mcp.binary).toHaveLength(1)
    expect(viewer.binary).toHaveLength(3)
  })

  it('answers the sender alone', async () => {
    const { sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    const seen: string[] = []
    viewer.on('message', (d, isBinary) => { if (!isBinary) seen.push(JSON.parse(d.toString()).type) })
    await setStream(mcp, sessionId, true)
    await settle(viewer)
    expect(seen).not.toContain('session:stream-set')
  })

  it('asks the agent for a keyframe when the holder starts reading a live device', async () => {
    const { agent, sessionId, fromAgent } = await registerAgent()
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await barrier(agent)
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    await barrier(agent)
    expect(idrRequests(fromAgent)).toBe(0)
    await setStream(mcp, sessionId, true)
    await barrier(agent)
    expect(idrRequests(fromAgent)).toBeGreaterThan(0)
  })

  it('asks for no keyframe when the stream is not ready, or when the holder stops reading', async () => {
    const { agent, sessionId, fromAgent } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    await setStream(mcp, sessionId, true)
    await barrier(agent)
    expect(idrRequests(fromAgent)).toBe(0)
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await barrier(agent)
    await setStream(mcp, sessionId, false)
    await barrier(agent)
    expect(idrRequests(fromAgent)).toBe(0)
  })

  it('refuses a connection that does not hold the session, and changes nothing', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    const stranger = await socket('mcp2')
    expect(await setStream(stranger, sessionId, true)).toMatchObject({ type: 'session:stream-refused', reason: 'not-session-owner' })
    expect(await setStream(viewer, sessionId, true)).toMatchObject({ type: 'session:stream-refused', reason: 'not-session-owner' })
    await frame(stream, jpeg(), viewer)
    await settle(mcp)
    expect(mcp.binary).toHaveLength(0)
  })

  it('refuses an unknown session', async () => {
    const mcp = await socket('mcp1')
    expect(await setStream(mcp, 'no-such-session', true)).toMatchObject({
      type: 'session:stream-refused', sessionId: 'no-such-session', reason: 'session-not-found',
    })
  })

  it('answers while the Mac is out of resources, because it spends no new encode', async () => {
    // Two devices on one Mac: the load is the Mac's, and a second session is what a join control needs.
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'mac-two',
      devices: ['dev0', 'dev1'].map((id) => ({ id, name: id, platform: 'ios', status: 'shutdown' })),
    }))
    const [held, other] = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions.map((r) => r.sessionId)
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, held!)
    agent.send(JSON.stringify({
      type: 'agent:resources',
      resources: { cpuPercent: 95, memUsedMB: 4000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 2, reportedAt: Date.now() },
    }))
    await barrier(agent)
    // Control: the same load does refuse a join, so the gate is armed and the reply below is not a quiet pass.
    const joiner = await socket('mcp2')
    joiner.send(JSON.stringify({ type: 'session:start', sessionId: other }))
    expect((await waitForType<GenericError>(joiner, 'error')).reason).toBe('agent-resources-exhausted')
    expect(await setStream(mcp, held!, true)).toMatchObject({ type: 'session:stream-set', stream: true })
  })

  it('advertises holder-stream in agents:listed', async () => {
    const mcp = await socket('mcp1')
    mcp.send(JSON.stringify({ type: 'agents:list' }))
    expect((await waitForType<AgentsListed>(mcp, 'agents:listed')).features).toContain('holder-stream')
  })
})
