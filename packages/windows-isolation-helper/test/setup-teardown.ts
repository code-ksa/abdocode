/**
 * CL-16A3-B2B-ROOT-FINAL-GATE §1 — stop the measurement server when a `bun test`
 * process ends, from a hook that actually fires.
 *
 * THE DEFECT THIS FIXES, measured rather than assumed. `harness.ts` registered
 * its teardown with `process.on("exit", stopServer)`. Under `bun test` that
 * handler is NEVER CALLED — proved with a probe test whose only job was to write
 * a file from an `exit` handler, which never appeared. So `shutdown.req` was
 * never written, the de-elevation server outlived the test process that owned
 * it, and its queue directory could not be removed because that same server held
 * it open.
 *
 * That is the whole reason a round could only ever reach "steady at 2 queue
 * directories, both reaped by the NEXT run": nothing in a run stopped its own
 * server, so cleanup had to be someone else's job. Reaping by a later invocation
 * is not zero residue — stop after one round and the server, its Windows-11
 * console and its queue are still on the machine.
 *
 * `afterAll` from a preloaded module runs once per test process, on the path
 * `bun test` really takes. The reaper in `scripts/harness-teardown.ts` remains
 * the ENFORCING gate at the round boundary: this makes a run self-cleaning, and
 * the reaper proves it.
 */
import { afterAll } from "bun:test"
import { stopServer } from "./harness"

afterAll(() => {
  // Cheap and idempotent when no server was ever started, and it returns
  // immediately for a queue adopted from a parent process.
  stopServer()
})
