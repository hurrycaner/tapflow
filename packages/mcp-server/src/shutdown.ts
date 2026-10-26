export type DrainTrigger = 'SIGINT' | 'SIGTERM' | 'transport-closed' | 'stdin-end'

export interface ExitDrainDeps {
  client: { disconnect(): void }
  recording: {
    manager: { drainForExit(ms: number): Promise<void> }
    uploader: { resumeParked(): void }
  }
  transport: { onclose?: () => void }
  proc?: Pick<NodeJS.Process, 'on' | 'exit' | 'listenerCount'>
  stdin?: Pick<NodeJS.ReadStream, 'once'>
  drainMs?: number
  log?: (line: string) => void
}

const EXTRA_CAP_MS = 1_000

/**
 * Every way this process can end (signal, closed transport, closed stdin) runs the same bounded
 * drain: finalize the recording, let the upload lane finish, then disconnect (V22/V23).
 */
export function installExitDrain(deps: ExitDrainDeps): { drain(trigger: DrainTrigger): Promise<void> } {
  const proc = deps.proc ?? process
  const stdin = deps.stdin ?? process.stdin
  const drainMs = deps.drainMs ?? 10_000
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))

  let started = false
  let finished = false

  const finish = (): void => {
    if (finished) return
    finished = true
    try { deps.client.disconnect() } catch { /* exiting anyway */ }
    proc.exit(0)
  }

  const drain = async (trigger: DrainTrigger): Promise<void> => {
    if (started) {
      // Ctrl-C twice means now (V22: bounded). Non-signal triggers are echoes of the same exit.
      if (!finished && (trigger === 'SIGINT' || trigger === 'SIGTERM')) {
        log('tapflow-rec: exiting now; uploads not finished')
        finished = true
        proc.exit(0)
      }
      return
    }
    started = true

    // Hard cap above drainForExit's own bound, so a hung finalize cannot hold the process open.
    let capTimer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, drainMs + EXTRA_CAP_MS)
      capTimer.unref()
    })
    const run = async (): Promise<void> => {
      try { deps.recording.uploader.resumeParked() } catch (err) { log(`tapflow-rec: resume failed: ${describe(err)}`) }
      try { await deps.recording.manager.drainForExit(drainMs) } catch (err) { log(`tapflow-rec: drain failed: ${describe(err)}`) }
    }
    try {
      await Promise.race([run(), capped])
    } finally {
      if (capTimer) clearTimeout(capTimer)
      finish()
    }
  }

  const fire = (trigger: DrainTrigger) => (): void => { void drain(trigger).catch(() => undefined) }

  proc.on('SIGINT', fire('SIGINT'))
  proc.on('SIGTERM', fire('SIGTERM'))

  // The SDK's stdio transport calls onclose only from its own close(); a host that closes stdin
  // never reaches it, hence the separate stdin hook.
  const previousOnClose = deps.transport.onclose
  deps.transport.onclose = () => {
    try { previousOnClose?.() } catch { /* never block the drain */ }
    fire('transport-closed')()
  }
  stdin.once('end', fire('stdin-end'))

  // Same shape as the CLI's handler: nothing in the recorder or lane should reach it, and if
  // something does, dying loudly beats a half-dead server (V31).
  if (proc.listenerCount('unhandledRejection') === 0) {
    proc.on('unhandledRejection', (err) => {
      log(err instanceof Error ? err.message : String(err))
      proc.exit(1)
    })
  }

  return { drain }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
