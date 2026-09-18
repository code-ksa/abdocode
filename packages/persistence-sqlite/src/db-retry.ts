/**
 * Bounded retry for transient SQLite contention (BUSY/LOCKED).
 *
 * ONLY wrap database-only work — never a transaction that also performs an
 * external side effect, because a retried side effect duplicates. Retries are
 * bounded with exponential backoff + jitter, then surface a typed
 * DatabaseBusyError instead of looping forever.
 */
import { DatabaseBusyError } from "@abdo/contracts/error"

export interface RetryOptions {
  readonly maxRetries?: number
  readonly baseMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface SyncRetryOptions {
  readonly maxRetries?: number
  readonly baseMs?: number
  readonly sleep?: (ms: number) => void
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function isBusy(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toUpperCase()
  return msg.includes("SQLITE_BUSY") || msg.includes("DATABASE IS LOCKED") || msg.includes("SQLITE_LOCKED")
}

export async function withBusyRetry<T>(fn: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 5
  const baseMs = options.baseMs ?? 10
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      if (!isBusy(error) || attempt >= maxRetries) {
        if (isBusy(error)) throw new DatabaseBusyError({ attempts: attempt + 1 })
        throw error
      }
      attempt++
      const backoff = baseMs * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * baseMs)
      await sleep(backoff + jitter)
    }
  }
}

const syncSleeper = new Int32Array(new SharedArrayBuffer(4))
const defaultSyncSleep = (ms: number) => {
  Atomics.wait(syncSleeper, 0, 0, ms)
}

/** Bounded synchronous retry for constructor-time SQLite setup only. */
export function withBusyRetrySync<T>(fn: () => T, options: SyncRetryOptions = {}): T {
  const maxRetries = options.maxRetries ?? 5
  const baseMs = options.baseMs ?? 10
  const sleep = options.sleep ?? defaultSyncSleep
  let attempt = 0
  while (true) {
    try {
      return fn()
    } catch (error) {
      if (!isBusy(error) || attempt >= maxRetries) {
        if (isBusy(error)) throw new DatabaseBusyError({ attempts: attempt + 1 })
        throw error
      }
      attempt++
      sleep(baseMs * 2 ** (attempt - 1))
    }
  }
}
