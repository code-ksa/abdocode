import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// أ2 — أسلاكُ بوّابة الاسم في cli.ts: الرفضُ يسبق بوّابةَ الموافقة لأفعال الإدخال الستّة؛ الثقةُ تُمنح بالمقبض حين يفتح الوكيلُ النافذة (desk open)،
// أو حين تظهر نافذةٌ جديدة منذ آخر عدّ، أو حين يجدها desk wait؛ ونصُّ المهمّة يُلتقط في كلّ دور (مع هدفٍ سابقٍ إن وُجد).
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("the refusal sits before the approval gate, on the six input kinds, with pid and trusted set", () => {
  expect(cli).toContain('import { windowAllowedByTask } from "./desktop-name-gate"')
  const refusal = cli.indexOf('if (desktopBound !== undefined && ["click", "type", "key", "scroll", "set", "press", "drag"].includes(action.kind)) {') // ن6: drag سابعُ أنواع الإدخال
  const gate = cli.indexOf('if (action.kind !== "windows" && action.kind !== "ui" && (action.kind !== "shot" || action.scope === "screen")) {')
  expect(refusal).toBeGreaterThan(0)
  expect(refusal).toBeLessThan(gate)
  expect(cli).toContain("const verdict = windowAllowedByTask({ title: desktopBound.title, pid: desktopBoundPid, hwnd: desktopBound.hwnd, taskText: desktopTaskText, trustedHwnds: desktopTrustedHwnds })")
  expect(cli).toContain('if (!verdict.ok) return denied(verdict.why, "policy_denied")')
})

test("trust sources: desk open, new windows since the last listing, desk wait; task text captured per turn", () => {
  expect(cli).toContain('if (action.kind === "open") desktopTrustedHwnds.add(result.bound.hwnd)')
  expect(cli).toContain("if (desktopKnownHwnds !== undefined && !known.has(w.hwnd)) desktopTrustedHwnds.add(w.hwnd)")
  expect(cli).toContain("if (win !== undefined) { desktopTrustedHwnds.add(win.hwnd); return okText(")
  expect(cli).toContain("desktopTaskText = `${turn.body}\\n${priorGoal?.goal ?? \"\"}`")
  expect(cli).toContain("desktopBoundPid = desktopPidByHwnd.get(result.bound.hwnd) ??")
  // 09-16 (مقيس على 4.0.44): تركيزُ المشغّل المباشر «desk focus pid:N» تسميةٌ صريحة تُوثّق النافذةَ للأدوار التالية؛ تركيزُ النموذج لا يوثّق
  expect(cli).toContain('if (action.kind === "focus" && result.bound !== undefined && desktopTaskText.split("\\n")[0]?.trim() === `desk ${rest.trim()}`) desktopTrustedHwnds.add(result.bound.hwnd)')
  expect(cli).toContain("desktopPidByHwnd.set(w.hwnd, w.pid)")
})
