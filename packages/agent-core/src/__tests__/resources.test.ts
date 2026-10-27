import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'

import { createResourceSampler } from '../utils/resources'

// The two reads run real executables: stand-ins written here, so a test sees exactly what the agent's
// event loop sees, including how long a slow one holds it.
let dir: string
const tool = (name: string, body: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}
const VM_STAT_OUT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages active:           100.',
  'Pages wired down:        50.',
  'Pages occupied by compressor:  25.',
  'Pages free:             1000.',
].join('\\n')

/** The longest the event loop went without turning while `work` ran. The gap up to the moment `work` settles
 *  counts too: a synchronous block that ends with `work` is over before any tick could see it. */
async function longestLoopStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const tick = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 5)
  try { await work() } finally { clearInterval(tick) }
  return Math.max(longest, performance.now() - last)
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-test-')) })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('createResourceSampler', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('getCpuPercent', () => {
    it('첫 호출은 0을 반환한다 (baseline 수집 단계)', () => {
      const { getCpuPercent } = createResourceSampler()
      expect(getCpuPercent()).toBe(0)
    })

    it('두 번째 호출에서 실제 CPU% 계산값을 반환한다', () => {
      // baseline: user=100, sys=100, idle=800 → total=1000
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // second: idle+100(→900), total+200(→1200) → cpu% = (1 - 100/200) × 100 = 50%
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBe(50)
    })

    it('total diff가 0이면 0을 반환한다 (NaN 방지)', () => {
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // 동일한 값 → totalDiff=0
      expect(getCpuPercent()).toBe(0)
    })

    it('100%를 초과하지 않는다 (clamp)', () => {
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // idle이 줄고 total이 늘어 가상의 100% 초과 상황
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 2000, nice: 0, sys: 0, idle: 500, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBeLessThanOrEqual(100)
    })

    it('복수 CPU 코어 값을 합산한다', () => {
      // baseline per core: user=100, idle=900 → total=1000 / 2 cores → 1800/2000
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline: idle=1800, total=2000

      // second per core: user=200, idle=1000 → total=1200 / 2 cores → 2000/2400
      // idleDiff=200, totalDiff=400 → cpu% = (1 - 200/400) × 100 = 50%
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 200, nice: 0, sys: 0, idle: 1000, irq: 0 } },
        { times: { user: 200, nice: 0, sys: 0, idle: 1000, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBe(50)
    })
  })

  describe('getMemoryUsage', () => {
    it('vm_stat 파싱 성공 시 active+wired+compressed 기반 memUsedMB 반환', async () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 * 1024 * 1024)
      const vmStat = tool('vm_stat_ok', `printf '${VM_STAT_OUT}\\n'`)

      const { memUsedMB, memTotalMB } = await createResourceSampler({ vmStat }).getMemoryUsage()

      // (100 + 50 + 25) × 16384 = 2,867,200 bytes → 3 MB (rounded)
      expect(memUsedMB).toBe(Math.round(175 * 16384 / 1024 / 1024))
      expect(memTotalMB).toBe(16 * 1024)
    })

    it('vm_stat 실패(status≠0) 시 os.freemem() 기반 fallback 사용', async () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 * 1024 * 1024)
      vi.spyOn(os, 'freemem').mockReturnValue(2 * 1024 * 1024 * 1024)

      const { memUsedMB, memTotalMB } = await createResourceSampler({ vmStat: tool('vm_stat_fail', 'exit 1') }).getMemoryUsage()

      expect(memUsedMB).toBe(6 * 1024) // 8GB - 2GB = 6 GB = 6144 MB
      expect(memTotalMB).toBe(8 * 1024)
    })

    it('vm_stat stdout이 비어있어도 fallback 사용', async () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(4 * 1024 * 1024 * 1024)
      vi.spyOn(os, 'freemem').mockReturnValue(1 * 1024 * 1024 * 1024)
      const { memUsedMB } = await createResourceSampler({ vmStat: tool('vm_stat_empty', 'true') }).getMemoryUsage()
      expect(memUsedMB).toBe(3 * 1024) // 4GB - 1GB = 3 GB = 3072 MB
    })

    it('does not hold the event loop while vm_stat runs', async () => {
      // 300 ms of vm_stat. Run synchronously, the loop would stall for all of it — the hitch a drag showed every 5 s.
      const vmStat = tool('vm_stat_slow', `sleep 0.3; printf '${VM_STAT_OUT}\\n'`)
      let reading: { memUsedMB: number } | undefined
      const stall = await longestLoopStall(async () => { reading = await createResourceSampler({ vmStat }).getMemoryUsage() })
      expect(reading?.memUsedMB).toBe(Math.round(175 * 16384 / 1024 / 1024))
      expect(stall).toBeLessThan(100)
    })

    it('gives up on a vm_stat that hangs, and falls back', async () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(4 * 1024 * 1024 * 1024)
      vi.spyOn(os, 'freemem').mockReturnValue(1 * 1024 * 1024 * 1024)
      const started = Date.now()
      const { memUsedMB } = await createResourceSampler({ vmStat: tool('vm_stat_hang', 'sleep 10') }).getMemoryUsage()
      expect(memUsedMB).toBe(3 * 1024)
      expect(Date.now() - started).toBeLessThan(3_000)
    })
  })

  describe('getMemoryPressure', () => {
    it.each([['1', 'normal'], ['2', 'warn'], ['4', 'critical']])('reads level %s as %s on macOS', async (raw, level) => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin')
      // The stand-in echoes its arguments too, so the key it was asked for is checked.
      const sysctl = tool(`sysctl_${raw}`, `[ "$*" = "-n kern.memorystatus_vm_pressure_level" ] && echo ${raw}`)
      expect(await createResourceSampler({ sysctl }).getMemoryPressure()).toBe(level)
    })

    it('gives no reading for a level it does not know, or when sysctl fails or is missing', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin')
      expect(await createResourceSampler({ sysctl: tool('sysctl_8', 'echo 8') }).getMemoryPressure()).toBeUndefined()
      expect(await createResourceSampler({ sysctl: tool('sysctl_fail', 'exit 1') }).getMemoryPressure()).toBeUndefined()
      expect(await createResourceSampler({ sysctl: path.join(dir, 'no-such-tool') }).getMemoryPressure()).toBeUndefined()
    })

    it('does not ask outside macOS, where the key does not exist', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux')
      // A stand-in that would answer if asked: the undefined has to come from not asking.
      expect(await createResourceSampler({ sysctl: tool('sysctl_would_answer', 'echo 1') }).getMemoryPressure()).toBeUndefined()
    })
  })
})
