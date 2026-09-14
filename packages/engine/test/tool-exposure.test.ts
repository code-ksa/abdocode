// م9و — الأدواتُ بحسب النيّة: الأساسيّة دائماً، والعائلاتُ حين يسمّيها الهدف أو تُستعمل أو تُورَّث من الدور السابق.
import { describe, expect, test } from "bun:test"
import { TOOLS } from "@abdo/tools"
import { TOOL_FAMILIES, exposedByIntent, exposureLine, familiesFor, familyOf, noteToolUse } from "../src/tool-exposure"

const callable = TOOLS.filter((t) => t.agentCallable).map((t) => t.name)
const exposedFor = (families: ReadonlySet<string>) => callable.filter((n) => exposedByIntent(n, families))

describe("tool exposure by intent", () => {
  test("every family tool exists in the catalogue, and core tools are always exposed", () => {
    for (const names of Object.values(TOOL_FAMILIES)) for (const n of names) expect(TOOLS.some((t) => t.name === n), n).toBe(true)
    const core = exposedFor(new Set())
    for (const must of ["read", "write", "edit", "run", "list", "grep", "plan", "git", "packages", "logs", "stop", "recall", "skill"]) expect(core).toContain(must)
    for (const hidden of ["open", "page", "shot", "tap", "desk", "team", "delegate"]) expect(core).not.toContain(hidden)
    // القياسُ الذي يبرّر الميزة: عائلةُ المتصفّح وحدها ثلثُ الكتالوج
    expect(callable.length - core.length).toBeGreaterThanOrEqual(14)
  })
  test("goal words open families (Arabic and English), and unrelated goals keep only the core", () => {
    expect([...familiesFor("افتح الموقع والتقط لقطة للصفحة الرئيسيّة")]).toEqual(["browser"])
    expect([...familiesFor("Verify the landing page in the browser at http://localhost:5173")]).toEqual(["browser"])
    expect([...familiesFor("وزّع العمل على فريقٍ بالتوازي")]).toEqual(["delegation"])
    expect([...familiesFor("افتح تطبيق سطح المكتب واضغط على حفظ")].sort()).toEqual(["browser", "desktop"])
    expect([...familiesFor("أضف دالّة تنسيق التاريخ في utils.ts واكتب اختبارها")]).toEqual([])
    expect([...familiesFor("")]).toEqual([])
  })
  test("using a family tool opens it for the rest of the turn; inheritance keeps last turn's families for «اكمل»", () => {
    const families = familiesFor("اكمل")
    expect(exposedByIntent("open", families)).toBe(false)
    expect(noteToolUse("read", families)).toBe(false)
    expect(noteToolUse("open", families)).toBe(true)
    expect(noteToolUse("shot", families)).toBe(false) // العائلةُ مفتوحةٌ أصلاً
    expect(exposedByIntent("shot", families)).toBe(true)
    const next = familiesFor("اكمل", families)
    expect(next.has("browser")).toBe(true)
    expect(familyOf("desk")).toBe("desktop"); expect(familyOf("read")).toBeUndefined()
    expect(exposureLine(30, 46, new Set(["browser"]))).toBe("🧰 أدوات معروضة: 30/46 (+browser)")
    expect(exposureLine(30, 46, new Set())).toContain("(الأساسيّة)")
  })
})
