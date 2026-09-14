import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ProductTools as Tools } from "@abdo/tools"
import { familyOf, TOOL_FAMILIES } from "../src/tool-exposure"

// ب8ج (مقيس 09-14 على المثبَّت): المهمّةُ «استخدم الإضافة» — النموذجُ ردّ «لا أداةَ باسم browser extension» لأنّ browser للمشغّل وحده.
// bridge أداةُ النموذج: status بلا بوّابة، pair فعلٌ خارجيّ بالبوّابة، وتُعرَّض مع عائلة المتصفّح حين تُذكر الإضافة.
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("bridge is agent-callable, in the browser family, and wired with a gate on pair", () => {
  const tool = Tools.TOOLS.find((t) => t.name === "bridge")
  expect(tool?.agentCallable).toBe(true)
  expect(tool?.usage).toBe("bridge [status | pair]")
  expect(tool!.summary.length).toBeLessThanOrEqual(512)
  expect(Tools.TOOLS.find((t) => t.name === "browser")?.agentCallable).toBe(false) // تبديلُ الخلفيّة يبقى للمستخدم
  expect(TOOL_FAMILIES.browser).toContain("bridge")
  expect(familyOf("bridge")).toBe("browser")
  expect(cli).toContain('if (name === "bridge") {')
  expect(cli).toContain('await gate(turnId, "outside-workspace", "اقترانُ إضافة المتصفّح (قد يُقلع المتصفّح)", "bridge")')
  expect(cli.indexOf('if (name === "bridge") {')).toBeLessThan(cli.indexOf('if (name === "browser") {'))
})
