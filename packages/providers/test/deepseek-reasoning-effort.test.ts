/** 10-11 — DeepSeek's `reasoning_effort` (low/high/max; its default is high) travels only when thinking is enabled. */
import { expect, test } from "bun:test"
import { prepareChatRequest, provider } from "../src"

const body = (input: { think: boolean; nativeTools: boolean; reasoningEffort?: "low" | "high" | "max" }) =>
  JSON.parse(prepareChatRequest({ provider: provider("deepseek")!, model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false, credentialOwner: "rust-worker", ...input }).body)

test("thinking on + an effort ⇒ reasoning_effort is in the request body", () => {
  expect(body({ think: true, nativeTools: false, reasoningEffort: "low" })).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" })
})

test("the twins: no effort given, or thinking off (native tools), ⇒ no reasoning_effort", () => {
  expect(body({ think: true, nativeTools: false })).not.toHaveProperty("reasoning_effort")
  expect(body({ think: true, nativeTools: true, reasoningEffort: "low" })).not.toHaveProperty("reasoning_effort")
  expect(body({ think: false, nativeTools: false, reasoningEffort: "low" })).not.toHaveProperty("reasoning_effort")
})
