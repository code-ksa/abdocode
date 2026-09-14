// م9و — أسلاكُ إظهار الأدوات بالنيّة في cli.ts، وإصلاحُ تصفير هدف الدور (مقيس 09-14: currentGoalText كان يُفرَّغ بعد ضبطه).
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const nl = source.includes("\r\n") ? "\r\n" : "\n"

describe("tool exposure wiring", () => {
  test("families are computed from the effective goal at turn start, expanded at dispatch, and filter the model's tool list", () => {
    expect(source).toContain('import { exposedByIntent, exposureLine, familiesFor, noteToolUse } from "./tool-exposure"')
    expect(source).toContain("let turnFamilies = new Set<string>()")
    const set = source.indexOf("turnFamilies = familiesFor(effectiveGoal, turnFamilies)")
    const goal = source.indexOf("currentGoalText = turn.body")
    expect(goal).toBeGreaterThan(0); expect(set).toBeGreaterThan(goal); expect(set - goal).toBeLessThan(120)
    const spec = source.indexOf("const spec = Tools.tool(word)")
    const note = source.indexOf("noteToolUse(spec.name, turnFamilies)", spec)
    expect(note).toBeGreaterThan(spec); expect(note - spec).toBeLessThan(260)
    // مرشِّحٌ مستقلّ قبل مرشِّح السقف — كي يبقى مسمارُ التفويض (delegation-wiring) بنصّه
    const exposure = source.indexOf(".filter((tool) => exposedByIntent(tool.name, turnFamilies))")
    const allow = source.indexOf(".filter((tool) => withinAllowlist(tool.name) && (tool.name !== DELEGATE_TOOL", exposure)
    expect(exposure).toBeGreaterThan(0); expect(allow).toBeGreaterThan(exposure); expect(allow - exposure).toBeLessThan(120)
    expect(source).toContain("await emitEvent(turn.id, exposureLine(callable.filter((t) => exposedByIntent(t.name, turnFamilies)).length, callable.length, turnFamilies))")
  })
  test("the goal is no longer reset to empty right after it is set (the manifest guard reads it during the turn)", () => {
    expect(source).not.toContain(`    newProjectPending = undefined${nl}    currentGoalText = ""`)
    // التصفيرُ الوحيد المسموح: لا شيء — الضبطُ في كلّ دورٍ يكفي؛ والقراءُ الوحيد هو حارسُ المانيفست
    expect(source.match(/^\s*(?:let )?currentGoalText = ""\s*$/gmu) ?? []).toHaveLength(1) // التعريفُ الأوّليّ فقط (سطرُ كودٍ لا تعليق)
    expect(source).toContain("projectManifestViolation(")
  })
})
