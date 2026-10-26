import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installExitDrain } from '../shutdown.js'

type Handler = (...args: unknown[]) => void

function setup(opts: { existingRejectionHandler?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const calls: string[] = []
  const proc = {
    on: vi.fn((ev: string, h: Handler) => { handlers.set(ev, h); return proc }),
    exit: vi.fn((code?: number) => { calls.push(`exit(${code})`); return undefined as never }),
    listenerCount: vi.fn(() => (opts.existingRejectionHandler ? 1 : 0)),
  }
  const stdinHandlers = new Map<string, Handler>()
  const stdin = { once: vi.fn((ev: string, h: Handler) => { stdinHandlers.set(ev, h); return stdin }) }
  const previousOnClose = vi.fn()
  const transport: { onclose?: () => void } = { onclose: previousOnClose }
  let resolveDrain: () => void = () => undefined
  const drainForExit = vi.fn((ms: number) => {
    calls.push(`drainForExit(${ms})`)
    return new Promise<void>((r) => { resolveDrain = r })
  })
  const resumeParked = vi.fn(() => { calls.push('resumeParked') })
  const disconnect = vi.fn(() => { calls.push('disconnect') })
  const log = vi.fn()
  const handle = installExitDrain({
    client: { disconnect },
    recording: { manager: { drainForExit }, uploader: { resumeParked } },
    transport,
    proc: proc as never,
    stdin: stdin as never,
    log,
  })
  return { handlers, stdinHandlers, proc, transport, previousOnClose, drainForExit, resumeParked, disconnect, log, calls, handle, resolve: () => resolveDrain() }
}

describe('installExitDrain', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('SIGTERM runs resumeParked, drainForExit(10_000), then disconnect and exit(0), only after the drain resolves', async () => {
    const t = setup()
    t.handlers.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.calls).toEqual(['resumeParked', 'drainForExit(10000)'])
    expect(t.disconnect).not.toHaveBeenCalled()
    expect(t.proc.exit).not.toHaveBeenCalled()
    t.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.calls).toEqual(['resumeParked', 'drainForExit(10000)', 'disconnect', 'exit(0)'])
  })

  it('stdin end triggers the drain', async () => {
    const t = setup()
    t.stdinHandlers.get('end')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.drainForExit).toHaveBeenCalledWith(10_000)
    t.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.proc.exit).toHaveBeenCalledWith(0)
  })

  it('transport.onclose triggers the drain and still calls the previous onclose', async () => {
    const t = setup()
    t.transport.onclose!()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.previousOnClose).toHaveBeenCalledTimes(1)
    expect(t.drainForExit).toHaveBeenCalledTimes(1)
    t.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.calls.slice(-2)).toEqual(['disconnect', 'exit(0)'])
  })

  it('a second SIGINT during the drain exits immediately with the log line', async () => {
    const t = setup()
    t.handlers.get('SIGINT')!()
    await vi.advanceTimersByTimeAsync(0)
    t.handlers.get('SIGINT')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.log).toHaveBeenCalledWith('tapflow-rec: exiting now; uploads not finished')
    expect(t.proc.exit).toHaveBeenCalledTimes(1)
    expect(t.proc.exit).toHaveBeenCalledWith(0)
    expect(t.drainForExit).toHaveBeenCalledTimes(1)
  })

  it('after the drain completed, further signals do nothing', async () => {
    const t = setup()
    t.handlers.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(0)
    t.resolve()
    await vi.advanceTimersByTimeAsync(0)
    t.handlers.get('SIGINT')!()
    t.handlers.get('SIGTERM')!()
    t.stdinHandlers.get('end')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.proc.exit).toHaveBeenCalledTimes(1)
    expect(t.disconnect).toHaveBeenCalledTimes(1)
    expect(t.drainForExit).toHaveBeenCalledTimes(1)
    expect(t.log).not.toHaveBeenCalled()
  })

  it('a drain that never resolves exits after drainMs + 1_000', async () => {
    const t = setup()
    t.handlers.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(10_999)
    expect(t.proc.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.calls.slice(-2)).toEqual(['disconnect', 'exit(0)'])
  })

  it('installs unhandledRejection only when none exists; it logs and exits 1', () => {
    const t = setup()
    t.handlers.get('unhandledRejection')!(new Error('boom'))
    expect(t.log).toHaveBeenCalledWith('boom')
    expect(t.proc.exit).toHaveBeenCalledWith(1)
    const u = setup({ existingRejectionHandler: true })
    expect(u.handlers.has('unhandledRejection')).toBe(false)
  })

  it('still disconnects and exits when resumeParked or drainForExit throws synchronously', async () => {
    const t = setup()
    t.resumeParked.mockImplementation(() => { throw new Error('r') })
    t.drainForExit.mockImplementation(() => { throw new Error('d') })
    expect(() => t.handlers.get('SIGTERM')!()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.disconnect).toHaveBeenCalledTimes(1)
    expect(t.proc.exit).toHaveBeenCalledWith(0)
  })
})
