/**
 * ح3/ح4/ح5 (2026-09-13) — ثلاثةُ أعطالٍ كشفتها مهمّةٌ حقيقيّة بلا تدخّل، وكلُّها في أسلاك الدور داخل cli.ts:
 * اسمٌ جديد = مشروعٌ جديد، الخلاصةُ لا تتجاوز البوّابات، وسقفُ الوضع المحلّيّ. الاختبارُ يقرأ المصدرَ (كأخواته
 * serve-wiring/token-economy-wiring) لأنّ الأسلاكَ لا تُستدعى مفردةً — والطفرةُ التي تُسقط سطراً تُحمرّ هنا.
 */
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("ح3 — a create-intent naming a different project blocks writes in the selected one until project-create", () => {
  test("the flag is computed from the semantic frame, cleared per turn and by project creation, and enforced at the write runner", () => {
    expect(source).toContain("let newProjectPending: string | undefined")
    expect(source).toContain('    turnIntent = undefined\r\n    newProjectPending = undefined'.replace(/\r\n/gu, source.includes("\r\n") ? "\r\n" : "\n"))
    // الاسمُ يُقرأ بعد «باسم/named» أوّلاً (09-13: هدفُ الإطار التقط اسمَ صفحةٍ مقتبساً «خدماتنا»)، والإطارُ احتياطٌ لنوع «مشروع» وحده.
    expect(source).toContain('const wantedProject = namedProject ?? (frame.intent.kind === "project" ? frame.intent.target : undefined)')
    expect(source).toContain('frame.intent.action === "create" && frame.intent.kind === "project" && wantedProject !== undefined')
    expect(source).toContain("if (wanted.length > 0 && !current.includes(wanted) && !wanted.includes(current)) { newProjectPending = wantedProject")
    expect(source).toContain("projectCreatedInTurn = (path) => { turnProjectDir = path; newProjectPending = undefined }")
    // الحبسُ يسبق التشغيلَ الفعليّ للكتابة — بسببٍ مسمّى يحمل أمرَ الإنشاء.
    const write = source.indexOf('      case "write":')
    expect(write).toBeGreaterThan(0)
    const block = source.slice(write, write + 600)
    expect(block.indexOf("if (newProjectPending !== undefined) return denied(")).toBeLessThan(block.indexOf("return runWriteToolV("))
    expect(block).toContain("نفّذ: project-create ${newProjectPending}")
  })
})

describe("ح4 — a completion claim over red gates is refuted by name, never silently kept", () => {
  test("the refutation sits inside the !completed branch and names the stop", () => {
    const start = source.indexOf("      if (!completed) {")
    const tail = source.slice(start, start + 900)
    expect(tail).toContain("test(lastAnswer)) answer += `\\n⚠ ادّعى النموذجُ الاكتمالَ ونقضته البوّابات (التوقّف: ${lastStop})")
    // التوأمُ الإيجابيّ: الخلاصةُ المكتملة تبقى بنصّها.
    expect(source).toContain("let answer = completed\r\n        ? `${lastAnswer}".replace(/\r\n/gu, source.includes("\r\n") ? "\r\n" : "\n"))
  })
})

describe("browser backend (owner 09-13): one setting, switchable from Settings and from chat, honoured before any surface is created", () => {
  test("setting key, validator, chat word, off-refusal and extension forwarding all exist in order", () => {
    expect(source).toContain('browserBackend?: "owned" | "extension" | "off"')
    expect(source).toContain('"desktopControlEnabled", "browserBackend", "autoCompact", "turnTokenCap", "turnNotifications", "updateCheckEnabled", "remoteControlEnabled", "memorySearchEnabled"')
    expect(source).toContain('return "browserBackend غير معروف (owned | extension | off)"')
    const runner = source.indexOf("const runSurfaceTool = async (name: string, rest: string, turnId: string): Promise<string> => {")
    const word = source.indexOf('if (name === "browser") {', runner)
    const off = source.indexOf('if (backend === "off" && !(name === "surface" && rest.trim() === "off") && !(name === "browser"))', runner)
    const forward = source.indexOf('if (backend === "extension" && name !== "surface") {', runner)
    const owned = source.indexOf("new CdpBrowser(port, ", runner)
    expect(runner).toBeGreaterThan(0)
    expect(word).toBeGreaterThan(runner)
    expect(off).toBeGreaterThan(word)
    expect(forward).toBeGreaterThan(off)
    expect(owned).toBeGreaterThan(forward)
    // التمريرُ إلى الإضافة يمرّ بالبوّابة نفسِها ويرفض بالاسم حين لا اقتران.
    const block = source.slice(forward, forward + 3400) // 09-14: اتّسع بتمرير page styles/dom/css/assets إلى inspect
    // مراجعة 09-14: متصفّحُ المستخدم الحقيقيّ — موافقةٌ في كلّ نداء (outside-workspace)، لا fill/key، وسياسةُ المواقع قبل open.
    expect(block).toContain('await gate(turnId, "outside-workspace", `إضافةُ المتصفّح (تبويبُك الحقيقيّ) ${target}: ${rest.slice(0, 120)}`, name)')
    expect(block).toContain('if (name === "fill" || name === "key") return "رُفض: الكتابةُ والمفاتيحُ في متصفّحك الحقيقيّ بيدك أنت')
    expect(block).toContain('if (target === "open" && !browserSiteAllowed(SETTINGS_FILE, rest.trim()))')
    expect(block).toContain("غيرُ موصولة — اضغط «وصّل» في الإعدادات ▸ الاتّصالات")
    expect(block).toContain("await session.call(toolName, callArgs)")
  })
})

describe("auto-compact (owner 09-13): older turns fold into a verified summary, context-left is measured, and «compact» works from chat", () => {
  test("wiring order: helper next to the conversation carrier, both lanes call it, the statusline reads the real ratio", () => {
    expect(source).toContain("const compactIfNeeded = async (turnId: string, summary: string, manual: boolean): Promise<boolean> => {")
    // مراجعة 09-14: بلا خلاصةٍ موثَّقة لا ضغطَ آليّاً — القصُّ القديم أصدقُ من «خلاصة» فارغة.
    expect(source).toContain('if (!manual && (loadSettings().autoCompact === false || summary.trim().length === 0)) { while (conversation.length > 12) conversation.splice(0, 2); return false }')
    expect(source.match(/await compactIfNeeded\(turn\.id/gu)).toHaveLength(3)
    expect(source).not.toContain("while (conversation.length > 12) conversation.splice(0, 2)\r\n      return { answer, completed }")
    expect(source).toContain("lastContextLeft = contextLeftOf(estimated, contextTokens)")
    expect(source.match(/contextLeft: lastContextLeft,/gu)).toHaveLength(2)
    expect(source.match(/contextLeft: 1,/gu)).toBeNull()
    expect(source.match(/contextLeft: lastContextLeft \}\)/gu)).toHaveLength(2)
    expect(source).toContain('if (/^\\/?compact$/iu.test(turn.body.trim()) || turn.body.trim() === "اضغط السياق") {')
  })
})

describe("observed 2026-09-13 on 4.0.2: browser commands are volatile (never «duplicate»), and the managed dev port follows the project stack", () => {
  test("the loop gets a volatile predicate covering the surface/desktop words, and parseServerCommand receives the project dir", () => {
    expect(source).toContain('volatile: (command) => /^(?:page|shot|find|look|scroll|network|console|dismiss|desk)\\b/u.test(command),')
    expect(source).toContain("const serverCommand = parseServerCommand(cmd, PROJECT_DIR)")
    expect(source).not.toContain("const serverCommand = parseServerCommand(cmd)\r\n".replace(/\r\n/gu, source.includes("\r\n") ? "\r\n" : "\n"))
  })
})

describe("ح5 — the local lane has a wall-clock and tool-count cap checked at the epoch boundary", () => {
  test("cap constants, provider-local detection, the boundary check, and the honest stop reason", () => {
    expect(source).toContain('const localLane = Providers.provider(selectedModel.ref.split("/")[0] ?? "")?.local === true')
    expect(source).toContain("const LOCAL_TURN_MS = 8 * 60_000, LOCAL_TOOL_CAP = 24")
    expect(source).toContain("if (epoch > 1 && localLane && (Date.now() - turnStartedAt > LOCAL_TURN_MS || allCommands.length >= LOCAL_TOOL_CAP)) {")
    expect(source).toMatch(/let lastStop: "complete" \| [^\n]*\| "tool_budget" \| "wall_clock_budget" \| "stuck" \| "turn_budget" = "complete"/u)
    expect(source.match(/lastStop = allCommands\.length >= LOCAL_TOOL_CAP \? "tool_budget" : "wall_clock_budget"/gu)).toHaveLength(1)
    // السقفُ يقف قبل `epochs = epoch` فلا تُعدّ حقبةٌ لم تبدأ.
    const check = source.indexOf('lastStop = allCommands.length >= LOCAL_TOOL_CAP')
    expect(check).toBeLessThan(source.indexOf("        epochs = epoch"))
  })
})
