import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PLUGINS, PluginInventory, neutralPluginContext, type PluginInventoryEntry } from "../src/plugin-registry"

/**
 * 🔴 **«لم يُقرأ» و«لم تقع حالتُه» ليسا الشيءَ نفسَه — وخلطُهما يقتل مفاتيحَ حيّة.**
 *
 * الجردُ يعدّ القراءات، فمفتاحٌ قارئُه في مسار سؤال الموافقة أو جسر MCP أو
 * إدخال سرّ يظهر في دورٍ لم يقع فيه شيءٌ من ذلك بـ`reads: 0`، فيقول السطرُ
 * «مُعلَن ولم يُقرأ». وقِيس: **سبعةُ مفاتيحَ موصولةٍ تبدو ميتةً** في جردِ دورٍ
 * عاديّ. وهو كذبٌ في اتجاه «لم يُنفَّذ» — عيبٌ كالكذب في الاتجاه الآخر.
 *
 * الحقيقةُ تسكن السجلَّ وحده (`readWhen` في الواصف): قائمةٌ ثانيةٌ تُصان في
 * القشرة بيدٍ تفترق عنه في أوّل إضافةٍ جديدة (سابقةُ `shellPluginReads`).
 */
const CLI = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
const SHELL = readFileSync(join(import.meta.dir, "..", "..", "desktop", "ui", "index.html"), "utf8")

test("a declared condition belongs to a real conditional reader — measured in the tree, not described", () => {
  const conditional = PLUGINS.filter((p) => p.readWhen !== undefined)
  // المجموعةُ مثبَّتةٌ بأسمائها: زيادةٌ أو نقصٌ قرارٌ يُعلَن، لا انزلاقٌ صامت.
  expect(conditional.map((p) => p.name).sort()).toEqual([
    "approvalTakeover", "cacheAccounting", "delegation", "denialBreaker", "inboundGuard",
    "mcpClient", "readCompaction", "resumeIntent", "reviewer", "secretIntake",
    "semanticInfer", "standingGrants", "trailCompaction", "unattendedDeny", "usageMeter",
  ])
  for (const p of conditional) {
    // شرطٌ لمفتاحٍ بلا قارئ كذبٌ في الاتجاه المقابل.
    expect(p.wired).toBe(true)
    expect(p.site).not.toBe("none")
    expect(p.readWhen!.length).toBeGreaterThan(6)
    // والقارئُ موجودٌ فعلاً في المحرّك — لا شرطَ لقراءةٍ لا تقع في الشجرة.
    const read = new RegExp(`(pluginOnNow|\\.read)\\(\\s*"${p.name}"`, "u")
    expect(read.test(CLI)).toBe(true)
  }
  // ولا يحمل الشرطَ مفتاحٌ قارئُه في القشرة وحدها: `site: "panel"` يقوله أصلاً.
  expect(PLUGINS.filter((p) => p.site === "panel" && p.readWhen !== undefined)).toEqual([])
})

test("the inventory carries the condition through, and only for the keys that have one", () => {
  const inventory = new PluginInventory({}, neutralPluginContext("win32"), { inventoryOn: true, rulesOn: true })
  inventory.read("walls", "turn")
  const rows = inventory.snapshot()
  const row = (name: string): PluginInventoryEntry => rows.find((r) => r.name === name)!
  // مفتاحٌ مشروطٌ لم تقع حالتُه: صفرُ قراءات **مع** شرطٍ منطوق.
  expect(row("unattendedDeny").reads).toBe(0)
  expect(row("unattendedDeny").readWhen).toBe("حين يُطرح سؤالُ موافقة")
  expect(row("unattendedDeny").effective).toBe(true)
  // ومفتاحٌ غيرُ مشروطٍ لا يُنسب إليه شرطٌ ليبدو معذوراً.
  expect(row("intentField").readWhen).toBeUndefined()
  expect(row("walls").reads).toBe(1)
  expect(row("walls").readWhen).toBeUndefined()
})

test("the plugin line follows an English interface, conditions included", async () => {
  const { readWhenForDisplay } = await import("../../desktop/ui/engine-lines.js")
  const source = /const plugSummary = \(entries\) => \{[\s\S]*?\n    \};/u.exec(SHELL)![0]
  const summary = new Function("shellPluginReads", "uiText", "readWhenForDisplay", "shellSettings", `${source}\nreturn plugSummary;`)(
    new Set(["activity"]), (en: string) => en, readWhenForDisplay, { language: "en" },
  ) as (entries: unknown[]) => string
  const line = summary([
    { name: "walls", reads: 1, effective: true, wired: true, site: "turn" },
    { name: "activity", reads: 0, effective: true, wired: true, site: "panel" },
    { name: "unattendedDeny", reads: 0, effective: true, wired: true, site: "call", readWhen: "حين يُطرح سؤالُ موافقة" },
    { name: "ghost", reads: 0, effective: true, wired: false, site: "none" },
  ])
  expect(line).toBe("🧩 Read, enabled: walls · Read in the shell: activity · Conditional, not triggered: unattendedDeny (when an approval question is asked) · Declared, not read: ghost (not wired)")
})

test("THE LIVE SHELL LINE (the positive twin): the seven stop being called dead, and a truly unread key still is", () => {
  // الدالّةُ المشحونةُ نفسُها تُستخرج وتُشغَّل — لا نصٌّ مُثبَّت يمرّ والسطرُ يكذب.
  const source = /const plugSummary = \(entries\) => \{[\s\S]*?\n    \};/u.exec(SHELL)?.[0]
  expect(source).toBeDefined()
  // السطرُ يُعرض بلغة الواجهة: العربيّةُ هنا هويّةٌ صريحة، والإنجليزيّةُ توأمٌ في الاختبار التالي.
  const make = new Function("shellPluginReads", "uiText", "readWhenForDisplay", "shellSettings", `${source}\nreturn plugSummary;`) as (
    reads: Set<string>, uiText: (en: string, ar: string) => string, readWhen: (text: string, language: string) => string, settings: { language: string },
  ) => (entries: unknown[]) => string
  const build = (reads: Set<string>) => make(reads, (_en, ar) => ar, (text) => text, { language: "ar" })
  const summary = build(new Set(["activity"]))
  const line = summary([
    { name: "walls", reads: 1, effective: true, wired: true, site: "turn" },
    { name: "miner", reads: 2, effective: false, wired: true, site: "turn" },
    { name: "activity", reads: 0, effective: true, wired: true, site: "panel" },
    { name: "unattendedDeny", reads: 0, effective: true, wired: true, site: "call", readWhen: "حين يُطرح سؤالُ موافقة" },
    { name: "mcpClient", reads: 0, effective: false, wired: true, site: "call", readWhen: "حين تُستدعى أداةٌ بجسر MCP" },
    { name: "ghost", reads: 0, effective: true, wired: false, site: "none" },
  ])
  expect(line).toContain("قُرئ مفعَّلاً: walls")
  expect(line).toContain("قُرئ معطَّلاً: miner×2")
  expect(line).toContain("قُرئ في القشرة: activity")
  expect(line).toContain("قارئُه مشروطٌ ولم تقع حالتُه: unattendedDeny (حين يُطرح سؤالُ موافقة)، mcpClient (حين تُستدعى أداةٌ بجسر MCP)")
  // والتوأمُ السالب: مفتاحٌ بلا قارئٍ **يبقى** في خانته — لا يستر الشرطُ ميتاً.
  expect(line).toContain("مُعلَن ولم يُقرأ: ghost (غير موصول)")
  expect(line).not.toContain("مُعلَن ولم يُقرأ: unattendedDeny")
  // وشرطٌ على مفتاحٍ غيرِ موصولٍ لا يُصدَّق: يُعرض ميتاً كما هو.
  const lying = build(new Set())([{ name: "ghost", reads: 0, effective: true, wired: false, site: "none", readWhen: "حين يقع شيء" }])
  expect(lying).toContain("مُعلَن ولم يُقرأ: ghost (غير موصول)")
})
