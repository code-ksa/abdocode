/**
 * أداتا الوكيل للموصّلات: `connectors` (من مربوطٌ وموصولٌ وبأيّ أدوات) و`connect <موصّل>` (يفتح متصفّحَ المستخدم للموافقة ثمّ
 * يُوصل خادمَ الموصّل في الجلسة نفسِها). 🔴 مقيس 10-02: الربطُ كان زرّاً في الإعدادات وحده — الوكيلُ لا يعرف من المربوط ولا يستطيع
 * أن يطلب الربط، فـ«اربط نوشن وأنشئ صفحة» لا تُنجَز من المحادثة. هنا ما هو نقيّ: حلُّ الاسم (عربيّاً ولاتينيّاً) والعرض؛ والتوصيلُ في cli.
 */
import { CONNECTORS, type ConnectorSpec } from "./registry"

/** أسماءٌ يكتبها المستخدم للموصّل نفسِه — المعرّفُ والاسمان من السجلّ يكفيان غالباً، وهذه لما يقوله الناس فعلاً. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gmail: "google", جيميل: "google", جيميلي: "google", drive: "google", درايف: "google", calendar: "google", التقويم: "google", جوجل: "google", "google drive": "google",
  نوشن: "notion", نوتون: "notion", نوشين: "notion",
  سلاك: "slack",
  لينير: "linear", لينيار: "linear",
  اسانا: "asana", أسانا: "asana",
  جيرا: "atlassian", jira: "atlassian", confluence: "atlassian", كونفلونس: "atlassian",
  فيجما: "figma", فيغما: "figma",
  انتركوم: "intercom",
  جرانولا: "granola",
  جاما: "gamma", غاما: "gamma",
  جيتهب: "github", "جيت هب": "github", جت_هب: "github",
})

const norm = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[ً-ٰٟـ]/gu, "").replace(/[إأآ]/gu, "ا").trim()

export function resolveConnector(word: string): ConnectorSpec | undefined {
  const w = norm(word)
  if (w.length === 0) return undefined
  const alias = Object.entries(ALIASES).find(([name]) => norm(name) === w)?.[1]
  return CONNECTORS.find((c) => c.id === (alias ?? w) || norm(c.label) === w || norm(c.labelAr) === w || norm(c.label.split(" ")[0]!) === w)
}

export interface ConnectorView {
  readonly id: string
  readonly label: string
  readonly labelAr: string
  readonly linked: boolean
  readonly needsClient: boolean
  readonly connected: boolean
  readonly ownerClient?: { readonly howTo: string } | null
}

/** سطرٌ لكلّ موصّل بحاله وأدواته الحيّة — الأدواتُ بأسمائها التي تُستدعى بها. */
export function renderConnectors(rows: readonly ConnectorView[], toolsOf: (id: string) => readonly string[]): string {
  const lines = rows.map((row) => {
    const name = `${row.labelAr} (${row.id})`
    if (row.linked && row.connected) {
      const tools = toolsOf(row.id)
      return `✓ ${name}: مربوطٌ وموصول — ${tools.length} أداة: ${tools.slice(0, 12).join("، ")}${tools.length > 12 ? "، …" : ""}`
    }
    if (row.linked) return `◐ ${name}: مربوط (الرموزُ في الخزنة) ولم يُوصل في هذه الجلسة بعد — connect ${row.id} يُوصله`
    if (row.needsClient) return `⚠ ${name}: يحتاج تطبيقاً خاصّاً قبل الربط — ${row.ownerClient?.howTo ?? "الإعدادات ← الموصّلات"}`
    return `○ ${name}: غيرُ مربوط — connect ${row.id} يفتح المتصفّح للموافقة`
  })
  return `الموصّلات (${rows.filter((r) => r.linked && r.connected).length} موصولٌ من ${rows.length}):\n${lines.join("\n")}`
}

/** إيصالُ الربط بعد انتهاء الرقصة: الحالةُ الأخيرة والأدواتُ التي صارت تُستدعى — أو سببُ التعثّر بنصّه. */
export function connectReceipt(label: string, state: string | undefined, detail: string | undefined, tools: readonly string[]): { readonly ok: boolean; readonly text: string } {
  if (state !== "linked") return { ok: false, text: `لم يُربط «${label}»: ${detail ?? "انتهت المحاولة بلا حالة"}${state === "authorizing" ? " — لم تكتمل الموافقة في المتصفّح خلال المهلة" : ""}` }
  if (tools.length === 0) return { ok: true, text: `رُبط «${label}» (الرموزُ في الخزنة) — لكنّ خادمَه لم يُعلن أدواته بعد في هذه الجلسة؛ أعد connectors بعد لحظات.` }
  return { ok: true, text: `رُبط «${label}» ووُصل — ${tools.length} أداة تُستدعى الآن بأسمائها: ${tools.join("، ")}` }
}
