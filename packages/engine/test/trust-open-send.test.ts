/**
 * 10-09 (measured on installed 4.0.111 through computer use): after «Trust and open» the engine reconnects; Enter in those seconds was
 * swallowed without a word (`!engineUp` ⇒ return), the trust card stayed «Opening…» forever and the header kept «Needs attention».
 * Now: the message is held with a notice and sent on `ready`; the card says «Opened ✓» when the trusted project frame arrives; the
 * shell lifts the attention stage that the trust request raised.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ui = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "desktop", "ui", name), "utf8")

test("a send before the engine is ready is held, announced, and fired on ready — never silently dropped", () => {
  const html = ui("index.html")
  expect(html).not.toContain("if (body.length === 0 || !engineUp) return;")
  expect(html).toContain("heldSend = true;")
  expect(html).toContain("المحرّك يبدأ — تُرسل رسالتُك فور جاهزيّته.")
  expect(html).toContain("if (heldSend) { heldSend = false; setTimeout(() => fire(), 0); }")
  // ordering: the held send fires after engineUp is set, inside the ready handler
  expect(html.indexOf("if (heldSend) { heldSend = false;")).toBeGreaterThan(html.indexOf("        engineUp = true;"))
})

test("the trust card settles to «Opened ✓» on the trusted project frame for the same path", () => {
  const html = ui("index.html")
  expect(html).toContain("pendingTrustCard = { path: f.path, node };")
  expect(html).toContain('if (f.trusted && pendingTrustCard !== null && pendingTrustCard.path === f.path) {')
  expect(html).toContain('"Opened ✓", "فُتح ✓"')
})

test("the shell lifts «Needs attention» raised by a trust request once the project arrives trusted", () => {
  const shell = ui("native-shell.js")
  expect(shell).toContain("if(f.kind==='trust-request')waitingForTrust=true;")
  expect(shell).toContain("if(waitingForTrust&&currentStage==='waiting'){waitingForTrust=false;setStage('idle');}")
})
