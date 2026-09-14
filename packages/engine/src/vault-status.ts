export interface VaultStatusRow {
  readonly provider: string
  readonly hasKey: boolean
}

/** One background snapshot per serve session; concurrent requests share its reply.
 * Only presence is read. Keeping worker calls serial avoids a process burst while
 * the shell continues receiving usage, settings and interruption frames.
 */
export function createVaultStatusReporter(deps: {
  providers: () => readonly string[]
  hasCredential: (provider: string) => Promise<boolean>
  emit: (frame: { kind: "vault-status"; status: VaultStatusRow[] }) => void
}) {
  let pending = false
  let disposed = false
  return {
    request(): void {
      if (pending || disposed) return
      pending = true
      // Defer even provider enumeration beyond the input-frame handler. There is
      // no completed-result cache: the next request sees newly saved credentials.
      void Promise.resolve().then(async () => {
        const status: VaultStatusRow[] = []
        for (const provider of new Set(deps.providers())) {
          if (disposed) return
          let hasKey = false
          try { hasKey = await deps.hasCredential(provider) === true } catch { /* Presence fails closed; never emit a worker error or value. */ }
          status.push({ provider, hasKey })
        }
        if (!disposed) deps.emit({ kind: "vault-status", status })
      }).catch(() => { /* A closed output channel must not reject an unobserved task. */ })
        .finally(() => { pending = false })
    },
    dispose(): void { disposed = true },
  }
}
