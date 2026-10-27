import { execFile } from 'node:child_process'

// Polled every 1.5 s while audio streams, on the loop that carries the video: `ps` over every process on the
// Mac takes ~40 ms, which held each frame and touch move behind it when this was `execFileSync`
// (contributing/agent-event-loop-blocking.md). A failed or hung `ps` reads as no processes.
const PS = '/bin/ps'
const PS_TIMEOUT_MS = 5_000

/** `ps` and `timeoutMs` are for tests. */
export function enumerateSimPids(udid: string, ps = PS, timeoutMs = PS_TIMEOUT_MS): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(ps, ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout) => resolve(err ? [] : parseSimPids(udid, stdout)))
  })
}

// Enumerate every host PID belonging to a booted simulator. A simulator's processes are all
// descendants of one `launchd_sim` whose command line embeds the device UDID (e.g.
// .../Devices/<UDID>/data/var/run/launchd_bootstrap.plist). We find that root and walk its tree —
// those are the processes a whole-sim audio tap must cover (the app + WebKit WebContent + system
// sounds), which a single-app tap misses. `out` is what `ps -axo pid=,ppid=,command=` prints.
export function parseSimPids(udid: string, out: string): number[] {
  const children = new Map<number, number[]>()
  let root = 0
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const command = m[3]
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)!.push(pid)
    if (command.includes('launchd_sim') && command.includes(udid)) root = pid
  }
  if (!root) return []

  // walk descendants (the root launchd_sim itself never emits audio, so it's excluded)
  const pids: number[] = []
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()!
    for (const c of children.get(p) ?? []) {
      pids.push(c)
      stack.push(c)
    }
  }
  return pids
}
