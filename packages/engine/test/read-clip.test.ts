/**
 * 10-01 — قصُّ القراءة بالأسطر. مقيس في Sprint 14: «عُرض 14000 من 24232 حرفاً» ⇦ النموذجُ طلب المقاطعَ بالأحرف، 13 قراءةً للملفّ،
 * ولم يبلغ آخرَه قطّ.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { clipReadBody, sliceReadRange } from "../src/read-range"

const plan = Array.from({ length: 299 }, (_, i) => `| ${i + 1} | سطرٌ من خطّة السبرنتات بنصٍّ عربيٍّ يطول قليلاً كي يتجاوز الملفُّ سقفَ العرض |`).join("\n")

describe("read clip by lines", () => {
  test("cut at a line boundary, the note names the last line shown and the exact command for the rest", () => {
    const shown = clipReadBody(plan, 14_000, 1, 299, "ABDO-SPRINTS.md")
    const m = /…\[قُصّ عند السطر (\d+) من 299 \(سقفُ العرض 14000 حرفاً\) — البقيّة: read ABDO-SPRINTS\.md (\d+) 299\]$/u.exec(shown)
    expect(m).not.toBeNull()
    const last = Number(m![1])
    expect(Number(m![2])).toBe(last + 1)
    // ما عُرض ينتهي بالسطر المسمّى كاملاً، لا بنصفه.
    expect(shown.split("\n\n…[")[0]!.split("\n").at(-1)).toBe(plan.split("\n")[last - 1])
    // اتّباعُ الأمر يعيد البقيّةَ بالضبط — لا فجوةَ ولا تكرار.
    const rest = sliceReadRange(plan, last + 1, 299)
    expect("slice" in rest && rest.slice.split("\n")[0]).toBe(plan.split("\n")[last])
    expect(shown.split("\n\n…[")[0]! + "\n" + ("slice" in rest ? rest.slice : "")).toBe(plan)
  })
  test("a range read is numbered from its own first line", () => {
    const slice = sliceReadRange(plan, 100, 299)
    if (!("slice" in slice)) throw new Error("slice")
    const shown = clipReadBody(slice.slice, 5_000, 100, 299, "ABDO-SPRINTS.md")
    const m = /قُصّ عند السطر (\d+) من 299/u.exec(shown)!
    expect(shown.split("\n\n…[")[0]!.split("\n").at(-1)).toBe(plan.split("\n")[Number(m[1]) - 1])
  })
  test("under the budget nothing changes; one line longer than the budget says so instead of naming a range", () => {
    expect(clipReadBody("a\nb", 100, 1, 2, "x.md")).toBe("a\nb")
    const minified = clipReadBody("x".repeat(500), 100, 1, 1, "app.min.js")
    expect(minified).toContain("السطر 1 وحده أطولُ من 100 حرفاً")
    expect(minified).not.toContain("read app.min.js")
  })
  test("the display cap follows the agent model's window, not a 9B constant (16k-char globals.css took three reads at 6000)", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("const readBudgetChars = (): number => Math.min(40_000, Math.max(READ_BUDGET, Math.round(AGENT_CONTEXT_TOKENS * 0.3)))")
    expect(cli).toContain("const readBudget = Math.max(projectDocumentReadLimit(file, readBudgetChars()), readBudgetChars())")
    // نافذةُ 65,536 ⇦ 19,661 حرفاً: globals.css (16,179) قراءةٌ واحدة.
    expect(Math.min(40_000, Math.max(6000, Math.round(65_536 * 0.3)))).toBeGreaterThan(16_179)
  })
  test("the read tool uses it; the character-count note is gone", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("const shown = clipReadBody(body, readBudget, firstLine, lastLine, file)")
    expect(cli).not.toContain("…[قُصّ: عُرض ${readBudget} من ${body.length} حرفاً]")
  })
})
