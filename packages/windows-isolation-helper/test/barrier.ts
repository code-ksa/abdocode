/**
 * CL-16A2-D-L §4 — deterministic rendezvous, not sleeps.
 *
 * Forcing an interleaving with `await sleep(300)` produces a test that passes
 * because of timing and fails because of timing, and tells you nothing either
 * way. A barrier is exact: every participant announces its arrival and NOBODY
 * proceeds until all of them have. The contention it creates is real and it
 * happens on purpose, every run.
 *
 * The rendezvous is a directory of arrival files because the participants are
 * separate PROCESSES, which is the whole point of this slice — an in-process
 * `Promise.all` cannot exercise SQLite's cross-process write lock.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export class BarrierTimeout extends Error {
  readonly reasonCode = "barrier_timeout"
}

/** Arrive at `name` and block until `expected` participants have arrived. */
export async function barrier(dir: string, name: string, me: string, expected: number, timeoutMs = 120_000): Promise<void> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.${me}`), String(Date.now()), "utf8")
  const deadline = Date.now() + timeoutMs
  const prefix = `${name}.`
  while (Date.now() < deadline) {
    let arrived = 0
    try {
      arrived = readdirSync(dir).filter((f) => f.startsWith(prefix)).length
    } catch {
      /* the directory is being written to; try again */
    }
    if (arrived >= expected) return
    // A short poll, NOT a guess at how long the other side needs: the exit
    // condition is the arrival count, so the interval only affects latency.
    await Bun.sleep(10)
  }
  throw new BarrierTimeout(`barrier "${name}" timed out: fewer than ${expected} participants arrived`)
}

/** Wait for a file to appear (used by a parent waiting for a child to reach a point). */
export async function waitForFile(path: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(10)
  }
  return false
}
