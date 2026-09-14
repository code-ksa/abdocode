/**
 * CL-16A3-B2B-ROOT-FINAL-GATE — one start → request → (maybe) stop cycle.
 *
 * The child does exactly what a `bun test` process does: it brings up the shared
 * de-elevation server, runs ONE request through it, and reports the queue it
 * owns. Then it waits for a command:
 *
 *   - `stop`  → it tears itself down cleanly (the normal exit path) and leaves;
 *   - killed  → it dies WITHOUT tearing down, leaving the server, its Windows-11
 *               console and the queue behind — exactly the leak the parent's
 *               deterministic reaper must then clean without help from a later run.
 *
 * Importing the harness installs its exit hook, so a clean `process.exit(0)` runs
 * `stopServer` too; a hard kill from the parent runs nothing, which is the point.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { queueDir, runUnelevated, stopServer } from "../harness"

const handshake = process.argv[2]!
const commandFile = process.argv[3]!

const r = await runUnelevated(["version"])
if (r.ok === false && r.stage === "harness") {
  writeFileSync(`${handshake}.error`, JSON.stringify(r))
  process.exit(3)
}
// The server is up and one request has completed. Tell the parent which queue is ours.
writeFileSync(handshake, JSON.stringify({ queue: queueDir(), pid: process.pid }))

for (;;) {
  if (existsSync(commandFile)) {
    if (readFileSync(commandFile, "utf8").trim() === "stop") {
      stopServer()
      process.exit(0)
    }
  }
  await Bun.sleep(50)
}
