import os from 'os'
import { execFile } from 'child_process'
import type { MemoryPressure } from '@tapflowio/protocol'

// Both reads run every 5 s on the agent's event loop, which also carries every video frame and touch move.
// They were `spawnSync` and held that loop for 4 ms in a built agent and ~200 ms under `pnpm dev`, which showed
// as a hitch in a drag every 5 s: contributing/agent-event-loop-blocking.md. Asynchronous, and by absolute path,
// which is where most of the dev-only cost was. A read that fails or times out is no reading.
const SPAWN_TIMEOUT_MS = 1_000
const VM_STAT = '/usr/bin/vm_stat'
const SYSCTL = '/usr/sbin/sysctl'

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (err, stdout) => resolve(err ? null : stdout))
  })
}

const PRESSURE_LEVELS: Record<string, MemoryPressure> = { '1': 'normal', '2': 'warn', '4': 'critical' }

/** `tools` points the two reads somewhere else, for tests. */
export function createResourceSampler(tools: { vmStat?: string; sysctl?: string } = {}) {
  const vmStat = tools.vmStat ?? VM_STAT
  const sysctl = tools.sysctl ?? SYSCTL
  let lastCpuTimes: { idle: number; total: number } | null = null

  function getCpuPercent(): number {
    let idle = 0, total = 0
    for (const cpu of os.cpus()) {
      const t = cpu.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.idle + t.irq
    }
    if (!lastCpuTimes) {
      lastCpuTimes = { idle, total }
      return 0
    }
    const idleDiff = idle - lastCpuTimes.idle
    const totalDiff = total - lastCpuTimes.total
    lastCpuTimes = { idle, total }
    if (totalDiff === 0) return 0
    return Math.min(100, Math.round((1 - idleDiff / totalDiff) * 1000) / 10)
  }

  // macOS: active + wired + compressed pages only. Falls back to os.freemem() on other OS.
  async function getMemoryUsage(): Promise<{ memUsedMB: number; memTotalMB: number }> {
    const memTotalMB = Math.round(os.totalmem() / 1024 / 1024)
    const stdout = await run(vmStat, [])
    try {
      if (!stdout) throw new Error('vm_stat failed')
      const lines = stdout.split('\n')
      const pageSize = parseInt(lines[0]?.match(/page size of (\d+)/)?.[1] ?? '16384')
      const get = (key: string) => {
        const m = lines.find((l) => l.startsWith(key))?.match(/:\s*(\d+)/)
        return parseInt(m?.[1] ?? '0')
      }
      const pages = get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')
      return { memUsedMB: Math.round(pages * pageSize / 1024 / 1024), memTotalMB }
    } catch {
      return { memUsedMB: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024), memTotalMB }
    }
  }

  // The kernel's verdict rather than a percentage of ours: an 8 GB Mac runs near-full and compressing all the
  // time, and only the kernel knows when that has stopped keeping up. macOS only; elsewhere there is no answer.
  async function getMemoryPressure(): Promise<MemoryPressure | undefined> {
    if (os.platform() !== 'darwin') return undefined
    const stdout = await run(sysctl, ['-n', 'kern.memorystatus_vm_pressure_level'])
    if (stdout === null) return undefined
    return PRESSURE_LEVELS[stdout.trim()]
  }

  return { getCpuPercent, getMemoryUsage, getMemoryPressure }
}
