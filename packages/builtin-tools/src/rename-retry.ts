import { renameSync } from "node:fs"

/**
 * The commit step of every atomic write — a same-directory rename — fails *transiently* on Windows with EPERM,
 * EACCES or EBUSY while a scanner, an indexer or an editor holds the target for a moment. Measured in the engine
 * suite (2026-09-28): the atomic browser-history write died with `EPERM: operation not permitted, rename` and the
 * same test passed on the next run, unchanged.
 *
 * Only those three codes are retried, only on Windows, and with a bounded backoff (~1.6 s in all). Anything else —
 * ENOENT, EXDEV, a real permission problem on another platform — is thrown at once: a retry must never hide a
 * failure that will not go away. Returns the attempt that succeeded, so a caller can say it had to wait.
 */
export const TRANSIENT_RENAME: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"])

export interface RenameRetryOptions {
  readonly attempts?: number
  readonly platform?: NodeJS.Platform
  readonly rename?: (from: string, to: string) => void
  readonly sleep?: (ms: number) => void
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function renameRetrying(from: string, to: string, options: RenameRetryOptions = {}): number {
  const attempts = Math.max(1, options.attempts ?? 8)
  const rename = options.rename ?? renameSync
  const sleep = options.sleep ?? sleepSync
  const retryable = (options.platform ?? process.platform) === "win32"
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to)
      return attempt
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (!retryable || attempt >= attempts || code === undefined || !TRANSIENT_RENAME.has(code)) throw error
      sleep(Math.min(25 * 2 ** (attempt - 1), 400))
    }
  }
}
