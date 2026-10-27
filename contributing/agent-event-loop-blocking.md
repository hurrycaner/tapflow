---
type: diagnosis
topics: [performance, streaming, agent-core, ios, android, measurement]
status: stable
related: [measurement, relay-backpressure-frame-drop]
---

# Why the agents never run a child process synchronously on a timer

> Read this before adding `spawnSync`, `execFileSync` or `execSync` anywhere an agent runs it more than
> once: a timer, a poll, a per-frame or per-input path. And read it before chasing a stream that stutters
> at a steady interval.

## The symptom

While dragging on an iOS simulator in the dashboard, the stream stopped for a moment at a steady interval,
about every 1.5–2 s. Dragging the same screen in Simulator.app was smooth.

## What it was not

Each of these was measured and ruled out before the cause was found. They are the obvious first guesses, so
they are worth not repeating.

- **Not the periodic IDR.** The iOS encoder forces a keyframe every 2 s, which matched the interval. But
  glass→glass on localhost was p95 7.5 ms and at most 19 ms, so no frame was late leaving the encoder.
- **Not the decoder.** Forcing `?decoder=wasm` made decoding four times slower and left the interval as it
  was.
- **Not the dashboard.** The built dashboard on :4000 stuttered exactly like the Vite one on :3001.

What the `?perf=1` panel did show was recv-fps dropping and then jumping above 30: frames held back and then
released together. glass→glass could not see it, because the agent stamps `capturedAt` when it *reads* a
frame from the capture helper, so time spent waiting on the agent's event loop happens before the stamp.

## The cause

Both agents ran child processes synchronously on timers, on the same event loop that forwards every video
frame and every touch move. Measured with `scripts/loop-probe.mjs`:

| What | Where | Every | Built agent (plain `node`) | `pnpm dev` (tsx) |
|---|---|---|---|---|
| `vm_stat` + `sysctl` (memory and memory pressure for `agent:resources`) | `agent-core/src/utils/resources.ts`, both agents | 5 s | ~4–5 ms | **~170–225 ms** |
| `ps -axo pid=,ppid=,command=` + `plutil` (the sim's process tree and volume) | `ios-agent` audio poll | 1.5 s | **~45 ms** (`ps` over ~1,000 processes) | larger |

A user on a built agent saw the 1.5 s audio poll. A contributor on `pnpm dev` saw the 5 s report much more,
which is why turning audio off made the stutter less frequent rather than making it go away.

All four now run with `execFile`, so the event loop keeps turning while the child runs. Measured: the same
`sysctl` that held the loop 40 ms synchronously held it 0.8 ms asynchronously. Each has a timeout, one
runs at a time, and a reading that lands after its socket or capture is gone is dropped.

## The tsx part, and what is still unknown

Under `pnpm dev`, starting a child process **by bare name** costs 40–60 ms more than it does in plain
`node`; by absolute path it costs the same 1.7 ms in both.

| | `spawnSync('sysctl')` | `spawnSync('/usr/sbin/sysctl')` |
|---|---|---|
| plain `node` | 2–4 ms | 1.7 ms |
| tsx | 40–44 ms | 1.8 ms |
| `pnpm exec` | 50–62 ms | 1.7 ms |

`PATH` was identical in both. An IPC channel, tsx's loader and preflight on their own, the number of open
file descriptors and `NODE_PATH` were each tried and none of them reproduced it. **The cause is not known.**
The agents call macOS's own tools by absolute path now (`/usr/bin/vm_stat`, `/usr/sbin/sysctl`,
`/bin/ps`, `/usr/bin/plutil`), which makes dev behave like a built agent, but that is a workaround for an
unexplained cost, not an explanation.

The practical consequence is the one that bites: **a stutter you see under `pnpm dev` may be far smaller in
a release, and one you do not see may still be there.** Measure on a built agent before deciding either way.

## How to look

```sh
NODE_OPTIONS="--import $PWD/scripts/loop-probe.mjs" pnpm dev
```

Run it from the repo root. The path has to be absolute: `pnpm dev` starts the relay and the agents in
`playground/`, so `./scripts/…` resolves to nothing there and the first process dies at start.

Every relay and agent process prints a line whenever its event loop stalls for 30 ms or more
(`LOOP_PROBE_MS` changes that), and a line for every synchronous child-process call or `os.cpus()` that
takes 10 ms or more, naming the command. A `blocked` line right after one of those names the cause.
A stall at a fixed interval is a timer: look for the `setInterval` with that period.

## The rule

On any path an agent runs repeatedly, use `execFile` or `spawn`, never their `Sync` forms. Give the call a
timeout, guard against two runs overlapping, and check that what it was for still exists when it returns.
A `Sync` call that runs once at startup or on a boot is acceptable; on a timer it is a stutter for every
session on that agent.

One synchronous call still runs repeatedly, off the steady streaming path: Android's
`EmulatorLauncher.probeEmulator` (`pgrep`), polled every 200–250 ms while a wipe or a shutdown settles,
which can stall another device's stream on the same agent for that long.

## Testing that something does not block

A test that asserts the loop kept turning passes when nothing blocks, which includes the case where the
measurement cannot see the block. The first version of the tests here did exactly that: a synchronous call
that finishes before the first timer tick is never seen by the tick, and the helper cleared its interval
right after. Reverting the fix to `execFileSync` left the test green. The helper now also counts the gap up
to the moment the work settles, and reverting to the synchronous call fails it. See
[test-and-guard-coverage.md](./test-and-guard-coverage.md): run the mutation that produces the absence.
