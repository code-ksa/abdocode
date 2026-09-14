import { expect, test } from "bun:test"
import { generateShellReference } from "../src"
test("generates a deterministic client reference", () => {
  const one = generateShellReference()
  expect(generateShellReference()).toBe(one)
  expect(one).toContain('kind: "submit"')
  expect(one).toContain('kind: "ready"')
  // جرد الإضافات مُكتلَج كإطارٍ صادر — مرجع العميل يولد صفّه حتماً.
  expect(one).toContain('{ kind: "plugins", direction: "out", required: ["turnId","entries"] }')
})
