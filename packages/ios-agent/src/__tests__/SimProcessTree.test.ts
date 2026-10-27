import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { enumerateSimPids, parseSimPids } from '../SimProcessTree'

const UDID = '0535B2B2-0C96-45FF-88F1-141848964031'
const OTHER = 'AAAAAAAA-1111-2222-3333-444444444444'

// Mimics `ps -axo pid=,ppid=,command=` output (pid, ppid, then the full command line).
const PS = [
  '    1     0 /sbin/launchd',
  '  999     1 /usr/sbin/some-host-daemon',
  `33817     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
  '33854 33817 SpringBoard',
  '34356 33817 MobileSafari',
  '34379 34356 com.apple.WebKit.WebContent', // grandchild via MobileSafari
  '34386 34356 com.apple.WebKit.GPU',
  // a second simulator — must NOT bleed into the first one's set
  `40000     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${OTHER}/data/var/run/launchd_bootstrap.plist`,
  '40001 40000 SpringBoard',
].join('\n')

describe('parseSimPids', () => {
  it('returns the full descendant tree of the matching launchd_sim (incl. grandchildren)', () => {
    expect(parseSimPids(UDID, PS).sort((a, b) => a - b)).toEqual([33854, 34356, 34379, 34386])
  })

  it('excludes the launchd_sim root itself (it emits no audio)', () => {
    expect(parseSimPids(UDID, PS)).not.toContain(33817)
  })

  it('isolates per-simulator: another booted sim does not bleed in', () => {
    expect(parseSimPids(OTHER, PS).sort((a, b) => a - b)).toEqual([40001])
  })

  it('returns [] when no launchd_sim matches the udid', () => {
    expect(parseSimPids('UNKNOWN-UDID', PS)).toEqual([])
  })
})

// `ps` runs for real: a stand-in, so the test sees what the agent's event loop sees.
describe('enumerateSimPids', () => {
  let dir: string
  const ps = (name: string, body: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simtree-test-'))
    fs.writeFileSync(path.join(dir, 'ps.out'), PS)
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads the tree without holding the event loop while ps runs', async () => {
    // `ps` over every process on a Mac takes ~40 ms; this one takes 300. Polled every 1.5 s while audio
    // streams, a synchronous read held each video frame and touch move behind it.
    const slow = ps('ps_slow', `sleep 0.3; cat ${path.join(dir, 'ps.out')}`)
    let last = performance.now()
    let longest = 0
    const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 5)
    const pids = await enumerateSimPids(UDID, slow).finally(() => clearInterval(tick))
    // The gap up to now counts too: a synchronous read would be over before any tick could see it.
    longest = Math.max(longest, performance.now() - last)
    expect(pids.sort((a, b) => a - b)).toEqual([33854, 34356, 34379, 34386])
    expect(longest).toBeLessThan(100)
  })

  it('reads a ps that fails, or hangs past its timeout, as no processes', async () => {
    expect(await enumerateSimPids(UDID, ps('ps_fail', 'exit 1'))).toEqual([])
    const started = Date.now()
    expect(await enumerateSimPids(UDID, ps('ps_hang', 'sleep 10'), 200)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
