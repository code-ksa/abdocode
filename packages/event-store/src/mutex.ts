/**
 * Keyed serial executor — one writer at a time per key.
 *
 * This is how V2 guarantees "single writer per aggregate": every append for a
 * given aggregateId runs to completion before the next begins, so sequence
 * assignment can never race. Different aggregates still run concurrently.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** Run `fn` after all prior work queued under `key`, serialized. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    // Chain onto the prior task; swallow its result/rejection so one failed
    // append does not poison the queue for the next.
    const next = prior.then(fn, fn)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, settled)
    // Once this is the last queued task, drop the key so the map stays bounded.
    settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key)
    })
    return next
  }

  /** True while any work is queued for `key` (best-effort, for diagnostics). */
  busy(key: string): boolean {
    return this.tails.has(key)
  }
}
