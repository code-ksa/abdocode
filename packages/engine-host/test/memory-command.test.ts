/**
 * 10-01 — هيرمس 7 العابرُ للحقب: ذاكرةُ الحقبة تحمل رأسَ الأمر الكاتب لا جسمَه.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_ARG_CHARS, memoryCommand, runTextAgentLoop } from "../src/text-agent-loop"

const css = ":root{--bg:#0a0d14}\n".repeat(900)

describe("memory command", () => {
  test("a long write keeps its head, size and fingerprint — not its body (the measured 16k globals.css)", () => {
    const stub = memoryCommand(`write src/app/globals.css <<< ${css}`)
    expect(stub.startsWith("write src/app/globals.css <<< [حمولةٌ كُتبت فعلاً: ")).toBe(true)
    expect(stub).toContain(`${css.length} حرفاً`)
    expect(stub).toMatch(/بصمة [0-9a-f]{8}/u)
    expect(stub.length).toBeLessThan(160)
    // البصمةُ للحمولة: حمولتان مختلفتان ⇦ بصمتان مختلفتان؛ الحمولةُ نفسُها ⇦ البصمةُ نفسُها.
    // طولٌ واحد ومحتوى مختلف ⇦ بصمتان مختلفتان (الطولُ وحده لا يفرّق).
    const fp = (s: string): string => /بصمة ([0-9a-f]{8})/u.exec(s)![1]!
    expect(fp(memoryCommand(`write a.css <<< ${css}x`))).not.toBe(fp(memoryCommand(`write a.css <<< ${css}y`)))
    expect(memoryCommand(`write a.css <<<\n${css}`)).toBe(memoryCommand(`write a.css <<<\n${css}`))
  })
  test("a long edit keeps path and separator; short commands and non-writing commands are untouched", () => {
    const edit = memoryCommand(`edit src/x.tsx :: ${"a".repeat(300)} => ${"b".repeat(300)}`)
    expect(edit.startsWith("edit src/x.tsx :: [تعديلٌ نُفّذ: ")).toBe(true)
    expect(memoryCommand("write a.ts <<< short")).toBe("write a.ts <<< short")
    expect(memoryCommand(`run ${"echo x && ".repeat(80)}`)).toBe(`run ${"echo x && ".repeat(80)}`)
    expect(memoryCommand(`read ${"a".repeat(MEMORY_ARG_CHARS + 10)}`)).toBe(`read ${"a".repeat(MEMORY_ARG_CHARS + 10)}`)
  })
  test("through the real loop: memory carries the stub, the answer keeps the body, and a short write is carried as written", async () => {
    const replies = [`نفّذ: write src/app/globals.css <<<\n${css}`, "نفّذ: write src/a.ts <<< export {}", "تم"]
    const result = await runTextAgentLoop({
      input: "اكتب الستايل", history: [], maxRounds: 6,
      ask: async () => replies.shift()!,
      dispatch: async (command) => `✍ ${command.split(/\s+/u)[1]} — كتابة ذرّية عبر السياسة`,
      isCallable: (name) => name === "write",
    })
    const memory = result.memory[1]!.content
    expect(memory).not.toContain(css.slice(0, 2_000))
    expect(memory).toContain("write src/app/globals.css <<< [حمولةٌ كُتبت فعلاً:")
    expect(memory).toContain("⚙ write src/a.ts <<< export {}")
    expect(result.answer).toContain(css.slice(0, 2_000))
    expect(memory.length).toBeLessThan(css.length / 4)
  })
  test("the epoch memory uses the compacted commands while the displayed answer keeps them whole", () => {
    const src = readFileSync(join(import.meta.dir, "../src/text-agent-loop.ts"), "utf8")
    expect(src).toContain("content: stripMeasure(withoutSummary(memoryAnswer))")
    expect(src).toContain("answer: withoutSummary(answer),")
    expect(src).toContain("`${commands.map((used) => `⚙ ${memoryCommand(used)}`).join(\"\\n\")}${answer.slice(commandPrefix.length)}`")
  })
})
