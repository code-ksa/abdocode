/**
 * 10-08 — مهمّة الموقع: «scroll down» رمى «Browser control command timed out» فمات الدورُ بعد ٦ دقائق. الأداةُ المتعطّلة فشلُ أداة.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { toolCrashResult } from "../src/tool-crash"

test("the measured crash becomes a failed tool result with a browser hint", () => {
  const r = toolCrashResult("scroll", new Error("Browser control command timed out"))!
  expect(r.verdict).toEqual({ ok: false, reason: "tool_failed", denied: false, detail: "Browser control command timed out" })
  expect(r.output).toContain("✕ «scroll» تعطّل: Browser control command timed out")
  expect(r.output).toContain("open <الرابط>")
})

test("cancellation still propagates; other errors get the generic hint; secrets in the message are masked", () => {
  expect(toolCrashResult("scroll", new DOMException("Cancelled", "AbortError"))).toBeUndefined()
  expect(toolCrashResult("read", new Error("EBUSY: resource busy"))!.output).toContain("أعد المحاولة")
  expect(toolCrashResult("run", new Error("failed with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))!.output).not.toContain("AAAAAAAAAAAAAAAAAAAA")
})

test("dispatchToolV wraps the raw dispatch in the crash handler", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  const at = cli.indexOf("const dispatchToolV = async")
  const body = cli.slice(at, at + 1200)
  expect(body).toContain("try {")
  expect(body).toContain("result = await dispatchToolRaw(word, body, turnId, hooks, nativeCall)")
  expect(body).toContain("const crash = toolCrashResult(word, error)")
  expect(body).toContain("if (crash === undefined) throw error")
})
