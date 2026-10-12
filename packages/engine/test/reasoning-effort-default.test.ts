/** 10-11 — agent calls default to DeepSeek reasoning_effort «low» (measured: same scores, ~2–2.6× faster, ~2.5× fewer tokens). */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("the agent lane sends the effort, and an unset env/setting means «low»", () => {
  expect(cli).toContain('const raw = process.env.ABDO_REASONING_EFFORT ?? loadSettings().reasoningEffort ?? "low"')
  expect(cli).toContain("think: !nativeTools, ...(agentReasoningEffort() === undefined ? {} : { reasoningEffort: agentReasoningEffort() })")
})
