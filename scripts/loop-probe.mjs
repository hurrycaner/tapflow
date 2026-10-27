// Event-loop probe for tapflow's own Node processes. Loaded through NODE_OPTIONS, so nothing in the
// code under test changes:
//
//   NODE_OPTIONS="--import $PWD/scripts/loop-probe.mjs" pnpm dev
//
// From the repo root, and by absolute path: `pnpm dev` starts the relay and agents in playground/, where a
// relative path resolves to nothing and the first process to start dies.
//
// It prints two kinds of line to stderr:
//   - `blocked NNms at <clock>`: the event loop did not turn for that long. Every message the process
//     relays (video frames, touch moves) waited that long too.
//   - `spawnSync|execFileSync|execSync NNms: <command> at <clock>`, or `os.cpus NNms`: a synchronous call
//     that took 10 ms or more. A `blocked` line right after one names the cause.
//
// Why it exists: contributing/agent-event-loop-blocking.md. LOOP_PROBE_MS changes the block threshold.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const TICK_MS = 10
const BLOCK_MS = Number(process.env.LOOP_PROBE_MS) || 30
const SLOW_CALL_MS = 10

const script = process.argv.slice(1).find((a) => /\.(ts|js|mjs|cjs)$/.test(a) && !a.includes('node_modules'))
const entry = script ?? process.argv[1] ?? '?'
// Decided on the path from the repo root, shortened only for display: `pnpm pre-release` starts the relay as
// packages/cli/src/index.ts, which its last two segments alone would not name.
const root = fileURLToPath(new URL('..', import.meta.url))
const fromRoot = entry.startsWith(root) ? entry.slice(root.length) : entry
const name = entry.split('/').slice(-2).join('/')

const clock = () => {
  const d = new Date()
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

// Every process `pnpm dev` starts inherits NODE_OPTIONS, Vite and pnpm included. Watch only the relay,
// the agents and the CLI, whose loops carry the stream.
if (/relay|agent|server|cli|tapflow/i.test(fromRoot) && !/vite|esbuild/i.test(fromRoot)) {
  const tag = `[loop-probe ${name} pid=${process.pid}]`

  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const blocked = now - last - TICK_MS
    last = now
    if (blocked >= BLOCK_MS) process.stderr.write(`${tag} blocked ${blocked.toFixed(0)}ms at ${clock()}\n`)
  }, TICK_MS).unref()

  const require = createRequire(import.meta.url)
  const cp = require('node:child_process')
  for (const fn of ['spawnSync', 'execFileSync', 'execSync']) {
    const orig = cp[fn]
    cp[fn] = function (...args) {
      const start = performance.now()
      try {
        return orig.apply(this, args)
      } finally {
        const ms = performance.now() - start
        if (ms >= SLOW_CALL_MS) {
          const command = typeof args[0] === 'string'
            ? [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(' ').slice(0, 80)
            : '?'
          process.stderr.write(`${tag} ${fn} ${ms.toFixed(0)}ms: ${command} at ${clock()}\n`)
        }
      }
    }
  }
  const os = require('node:os')
  const cpus = os.cpus
  os.cpus = function () {
    const start = performance.now()
    try {
      return cpus.call(this)
    } finally {
      const ms = performance.now() - start
      if (ms >= SLOW_CALL_MS) process.stderr.write(`${tag} os.cpus ${ms.toFixed(0)}ms at ${clock()}\n`)
    }
  }
  // A module that wrote `import { spawnSync } from 'node:child_process'` bound the original at load.
  // This pushes the wrapped functions into those bindings.
  syncBuiltinESMExports()

  process.stderr.write(`${tag} watching (block ≥${BLOCK_MS}ms, sync call ≥${SLOW_CALL_MS}ms)\n`)
}
