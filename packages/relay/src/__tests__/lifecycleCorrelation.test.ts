import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AppLaunchToAgent, DeviceBoot, DeviceBootError, DeviceReady, DeviceShutdown, DeviceShutdownDone } from '@tapflowio/protocol'

// L5b′. `device:boot` / `device:shutdown` correlate by `requestId`, and unlike the app commands the
// correlator on every reply is **optional** — `device:ready`, `device:boot-error` and
// `device:shutdown-done` all have producers that answer no request at all.
//
// That optionality is why this file exists. `<Pair>ReplyBody` cannot be built for an optional field, so
// the compiler enforces nothing here; and `correlatedRequestsGated` derives its set from *required*
// declarations, so it cannot see this pair either. Every guarantee below is held by a test or by nothing.
describe('lifecycle correlation (device:boot / device:shutdown)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-lifecycle-corr-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  async function registerAgent(status: 'booted' | 'shutdown' = 'shutdown') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'lifecycleCorrelation-1',
      devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status }],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    return { agent, sessionId: reply.registeredSessions[0]!.sessionId }
  }

  async function joinAs(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return browser
  }

  // ── the relay is itself a producer of device:boot-error ──────────────────────────────────────────
  //
  // This is the position no static check reaches. The relay answers a `device:boot` on its own when it
  // cannot hand it to an agent, and an MCP caller that receives that diagnosis without the correlator
  // reads it as unsolicited and waits out its 30s instead — the diagnosis arrives and is thrown away.
  // The same defect shipped twice from agent code (`open-url:error`, then `clipboard:error` a slice
  // later); here the producer is the relay and the field is optional, so a test is the only thing
  // between it and a third recurrence.

  it('echoes the correlator on the boot-error it originates for an unknown session', async () => {
    const { agent } = await registerAgent()
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)

    browser.send(JSON.stringify({
      type: 'device:boot', sessionId: 'no-such-session', requestId: 'rq-unknown',
      payload: { deviceId: 'devA' },
    }))
    const err = await waitForType<DeviceBootError>(browser, 'device:boot-error')

    expect(err.message).toBe('Session not found')
    expect(err.requestId).toBe('rq-unknown')

    agent.close(); browser.close()
  })

  it('echoes the correlator on the boot-error it originates when the agent is gone', async () => {
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({
      type: 'device:boot', sessionId, requestId: 'rq-offline', payload: { deviceId: 'devA' },
    }))
    const err = await waitForType<DeviceBootError>(browser, 'device:boot-error')

    // The two diagnoses are deliberately different — reporting a stale session id as a dead Mac sends
    // the reader after the wrong problem — so both exits need the echo, not just one.
    expect(err.message).toBe('agent offline')
    expect(err.requestId).toBe('rq-offline')

    browser.close()
  })

  it('carries the correlator through to the agent, so the reply can be attributed', async () => {
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const forwarded = waitForType<DeviceBoot>(agent, 'device:boot')
    browser.send(JSON.stringify({
      type: 'device:boot', sessionId, requestId: 'rq-fwd', payload: { deviceId: 'devA' },
    }))

    // The relay mutates `payload` on the way through (it adds `external`), so this frame is not simply
    // relayed verbatim — the correlator surviving that is worth an assertion of its own.
    expect((await forwarded).requestId).toBe('rq-fwd')

    agent.close(); browser.close()
  })

  // The iOS agent warms its UI-tree runner on a boot tagged `automation`. A dashboard boot must never be: the
  // runner costs about 520 MB per device and manual testing never reads the tree.
  it.each([
    ['flow-runner', true],
    ['mcp', true],
    ['dashboard', false],
    [undefined, false],
  ] as const)('tags a boot by a %s holder automation=%s', async (clientKind, expected) => {
    const { agent, sessionId } = await registerAgent()
    const holder = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(holder)
    holder.send(JSON.stringify({ type: 'session:start', sessionId, ...(clientKind ? { clientKind } : {}) }))
    await waitForType(holder, 'session:joined')

    const forwarded = waitForType<DeviceBoot>(agent, 'device:boot')
    holder.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-kind', payload: { deviceId: 'devA' } }))

    expect((await forwarded).payload).toMatchObject({ automation: expected })

    agent.close(); holder.close()
  })

  it('overwrites an automation flag a browser sent itself', async () => {
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const forwarded = waitForType<DeviceBoot>(agent, 'device:boot')
    browser.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-forged', payload: { deviceId: 'devA', automation: true } }))

    expect((await forwarded).payload).toMatchObject({ automation: false })

    agent.close(); browser.close()
  })

  function insertBuild(): number {
    const db = getDb()
    const key = `com.example.launch${Math.abs(Number(process.hrtime.bigint() % 1000000n))}`
    db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Demo', ?, 'ios')`).run(key)
    const app = db.prepare('SELECT id FROM apps WHERE bundle_id_key = ?').get(key) as { id: number }
    const r = db.prepare(`INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path) VALUES (?, '1.0.0', '1', ?, '/tmp/x.app')`)
      .run(app.id, key)
    return Number(r.lastInsertRowid)
  }

  // The iOS agent disarms its network hook for an automation launch. An automation client on an already-booted
  // device never boots, so `app:launch` has to carry the flag too.
  it.each([
    ['flow-runner', true],
    ['mcp', true],
    ['dashboard', false],
    [undefined, false],
  ] as const)('tags a launch by a %s holder automation=%s', async (clientKind, expected) => {
    const { agent, sessionId } = await registerAgent('booted')
    const holder = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(holder)
    holder.send(JSON.stringify({ type: 'session:start', sessionId, ...(clientKind ? { clientKind } : {}) }))
    await waitForType(holder, 'session:joined')

    const forwarded = waitForType<AppLaunchToAgent>(agent, 'app:launch')
    holder.send(JSON.stringify({ type: 'app:launch', sessionId, requestId: 'rq-launch', buildId: insertBuild() }))

    expect((await forwarded).payload).toMatchObject({ automation: expected })

    agent.close(); holder.close()
  })

  it('overwrites an automation flag a browser sent on a launch', async () => {
    const { agent, sessionId } = await registerAgent('booted')
    const browser = await joinAs(sessionId)

    const forwarded = waitForType<AppLaunchToAgent>(agent, 'app:launch')
    browser.send(JSON.stringify({
      type: 'app:launch', sessionId, requestId: 'rq-forged-launch', buildId: insertBuild(),
      automation: true, payload: { automation: true },
    }))

    expect((await forwarded).payload).toMatchObject({ automation: false })

    agent.close(); browser.close()
  })

  it('carries the correlator through on a shutdown a browser asked for', async () => {
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const forwarded = waitForType<DeviceShutdown>(agent, 'device:shutdown')
    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId, requestId: 'rq-down', payload: { deviceId: 'devA' },
    }))

    expect((await forwarded).requestId).toBe('rq-down')

    agent.close(); browser.close()
  })

  // ── device:boot is gated at the door ─────────────────────────────────────────────────────────────
  //
  // `DeviceBoot.requestId` is required, so an id-less boot is a frame no in-repo sender can build — it
  // reaches here only from a third-party client or the unvalidated-inbound gap (#444). The policy is the
  // same as `open-url`'s: not forwarded, not answered, logged. Answering it would ship a
  // `device:boot-error` whose required correlator `JSON.stringify` erases, which every correlating
  // consumer then discards — turning a diagnosis into a caller waiting out its deadline.

  /** Sends `raw` from the browser and reports what, if anything, each side saw.
   *
   *  Two barriers, and both are needed. The trigger travels on the **browser** socket, so that is what
   *  proves the relay has processed it; the observation is on the **agent** socket, so that one proves a
   *  forward would already have been recorded. An earlier version of this shape in the app-command tests
   *  used a 0ms deadline with no barrier at all and passed on the next tick regardless — and a later one
   *  barriered only the agent, which orders nothing against a browser-sent trigger. */
  async function bootAndWatch(build: (sessionId: string) => Record<string, unknown>) {
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    // The session is **real** and its agent socket is open, so with the gate removed this boot is
    // forwarded and `forwarded` goes non-null. Using a bogus session id instead would also fail without
    // the gate, but by producing a `Session not found` — a pass keyed on the branch after the one under
    // test, which would keep passing if the gate moved below the lookup.
    browser.send(JSON.stringify(build(sessionId)))
    await barrier(browser)
    await barrier(agent)

    const forwarded = await waitForTypeOrNull<DeviceBoot>(agent, 'device:boot', 0)
    const answered = await waitForTypeOrNull<DeviceBootError>(browser, 'device:boot-error', 0)
    agent.close(); browser.close()
    return { forwarded, answered }
  }

  it('drops a boot with no correlator, and does not answer it either', async () => {
    const { forwarded, answered } = await bootAndWatch((sessionId) => ({
      type: 'device:boot', sessionId, payload: { deviceId: 'devA' },
    }))
    expect(forwarded).toBeNull()
    expect(answered).toBeNull()
  })

  it('drops a boot whose correlator is the empty string', async () => {
    // The other half of the shared predicate. `''` type-checks against `requestId: string`, and
    // `mcp-server`'s tool schemas are bare `z.string()`, so a model can put it on the wire. A gate
    // written as `!== undefined` would pass it through and every other test here would stay green.
    const { forwarded, answered } = await bootAndWatch((sessionId) => ({
      type: 'device:boot', sessionId, requestId: '', payload: { deviceId: 'devA' },
    }))
    expect(forwarded).toBeNull()
    expect(answered).toBeNull()
  })

  // ── device:shutdown is deliberately ungated ──────────────────────────────────────────────────────

  it('forwards a shutdown that carries no correlator', async () => {
    // The relay originates this message itself from the idle timer, with no browser and no id behind
    // it, so an absent correlator is not an error and the door cannot gate on it. The two live in one
    // `case` block away from each other: they shared a fall-through clause until this slice split them,
    // and an `isCorrelated(msg)` written into the shared body would have taken this path down with it —
    // silently, since nothing replies to a shutdown. `correlatedRequestsGated` resolves fall-through by
    // sharing the next non-empty body, so it would have read that gate as covering both and passed.
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const forwarded = waitForType<DeviceShutdown>(agent, 'device:shutdown')
    browser.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'devA' } }))

    const msg = await forwarded
    expect(msg.sessionId).toBe(sessionId)
    expect(msg.requestId).toBeUndefined()

    agent.close(); browser.close()
  })

  // ── the replay answers no boot, and nothing else says so ─────────────────────────────────────────

  it('replays device:ready with neither a sessionId nor a correlator', async () => {
    // **This is the invariant the whole pair rests on**, and before this test it was held by nothing:
    // with the replay mutated to stamp `sessionId`, all 591 relay tests, the dashboard's 317 and the
    // entire static suite still passed.
    //
    // Both boot waiters (`mcp-server`, `flow-runner`) compare `msg.sessionId === sessionId` with no
    // truthiness escape, so the *absence* of the key is what stops a cached ready from satisfying an
    // in-flight boot — measured once as `boot_device` answering `{booted:true}` with the agent having
    // sent nothing. Stamping it would delete that, and the optional correlator cannot replace it: an
    // optional field cannot make a frame fail to match, only make it match more precisely.
    //
    // So this asserts an absence, which D25 says is worth only as much as the mutation that creates it.
    // Verified both ways: adding `sessionId: session.id` to the replay fails the first expectation, and
    // adding `requestId` to it is not even expressible — the relay has no request to take one from,
    // which is the point the second expectation records.
    const { agent, sessionId } = await registerAgent()
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    await barrier(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    await barrier(browser)
    const ready = await waitForTypeOrNull<DeviceReady>(browser, 'device:ready', 0)

    expect(ready).not.toBeNull()
    expect('sessionId' in ready!).toBe(false)
    expect('requestId' in ready!).toBe(false)

    agent.close(); browser.close()
  })

  it('forwards an agent reply with its correlator intact and does not invent one', async () => {
    // The relay forwards agent→browser replies with `JSON.stringify(msg)` and never inspects them, so
    // it can neither add a correlator nor drop one. Both halves matter: the echo obligation lives
    // entirely in the agents, and a relay that "helpfully" stamped a reply would make every consumer's
    // correlator meaningless while every test still passed.
    const { agent, sessionId } = await registerAgent()
    const browser = await joinAs(sessionId)

    const ready = waitForType<DeviceReady>(browser, 'device:ready')
    agent.send(JSON.stringify({
      type: 'device:ready', sessionId, requestId: 'rq-echoed', payload: { deviceId: 'devA' },
    }))
    expect((await ready).requestId).toBe('rq-echoed')

    const done = waitForType<DeviceShutdownDone>(browser, 'device:shutdown-done')
    agent.send(JSON.stringify({
      type: 'device:shutdown-done', sessionId, payload: { deviceId: 'devA' },
    }))
    // An agent that predates the echo, or the unsolicited path: absent stays absent on the way through.
    expect((await done).requestId).toBeUndefined()

    agent.close(); browser.close()
  })
})
