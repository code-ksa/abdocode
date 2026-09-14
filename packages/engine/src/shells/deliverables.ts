/**
 * IDEA 9 — «المسلَّمات»: ما أنتجه الدور فعلاً، من الحكم لا من النيّة.
 *
 * لوحةُ النشاط تسجّل المخرج على إطار `tool` — أي قبل أن يُنفَّذ شيء. فأداةٌ
 * وقفت على بوابة موافقةٍ ثم رُفضت تظهر «مخرجاً»، وكتابةٌ فشلت كذلك. هذا
 * المُخفِّض يقرأ الوجه الآخر من الإيصال: حقل `locations` الذي لا يركب الإطار
 * إلا وحكمُ الأداة صريحٌ يقول ok. لا استنتاج من النصّ، ولا صفٌّ يدّعي كتابةً
 * لم يشهد بها حكم.
 *
 * وخوادمُ الدور تُقتل حتماً على **مخرجَيه** — التمام والسقوط معاً
 * (‏`turnServers.stopAll()`)، فصفُّ الخادم يقلب إلى «أُوقف» على أيّ نهايةٍ
 * مسمّاة (`done` · `interrupted` · `unresolved` · `refused`): لا يبقى يعِد
 * برابطٍ ميت. وقبل هذا كان مسارُ السقوط يترك الوعد قائماً بلا خادم.
 *
 * خالصة: لا DOM ولا شبكة.
 */

export type DeliverableKind = "file" | "server" | "url"

export interface DeliverableRow {
  readonly key: string
  readonly kind: DeliverableKind
  readonly label: string
  readonly turnId: string
  readonly op?: "write" | "edit" | "skipped"
  readonly live?: boolean
}

export interface DeliverablesState {
  readonly rows: readonly DeliverableRow[]
}

export const empty = (): DeliverablesState => Object.freeze({ rows: Object.freeze([] as readonly DeliverableRow[]) })

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

/**
 * دمجُ صفٍّ فوق صفّ: آخرُ حالةٍ تفوز **إلا** أن يكون الوافد نفياً للتغيير.
 * إيصالُ «⏭ نفس المحتوى» يقول «لم أكتب ثانيةً» لا «لم يُكتب شيء»؛ فحين
 * يعيد النموذج كتابةً وقعت في هذا الدور نفسه كان الصفُّ ينقلب «⏭ بلا
 * تغيير» — فتقول اللوحة عن ملفٍ أنشأه الدورُ للتوّ إنه لم يتغيّر.
 */
const merge = (existing: DeliverableRow, row: DeliverableRow): DeliverableRow =>
  row.op === "skipped" && (existing.op === "write" || existing.op === "edit")
    ? { ...existing, ...row, op: existing.op }
    : { ...existing, ...row }

/** إدراجٌ ينزع التكرار بالمفتاح ويُبقي الموضع الأوّل. */
const upsert = (rows: readonly DeliverableRow[], row: DeliverableRow): DeliverableRow[] => {
  const index = rows.findIndex((existing) => existing.key === row.key)
  if (index < 0) return [...rows, row]
  return rows.map((existing, i) => (i === index ? merge(existing, row) : existing))
}

export const fold = (state: DeliverablesState, frame: Record<string, unknown>): DeliverablesState => {
  const kind = asText(frame.kind)
  const turnId = asText(frame.turnId)
  if (kind === "browse") {
    const url = asText(frame.url)
    if (url.length === 0) return state
    return Object.freeze({ rows: Object.freeze(upsert(state.rows, { key: `url:${url}`, kind: "url", label: url, turnId })) })
  }
  if (kind === "tool-result") {
    const verdict = frame.verdict as { ok?: unknown } | undefined
    // الغياب رفضٌ لا إذن: بلا حكمٍ صريحٍ ok لا صفّ — ولو حمل الإطار مواضع.
    if (verdict === undefined || verdict === null || verdict.ok !== true) return state
    const locations = frame.locations
    if (!Array.isArray(locations) || locations.length === 0) return state
    let rows = state.rows
    for (const raw of locations) {
      if (typeof raw !== "object" || raw === null) continue
      const location = raw as Record<string, unknown>
      if (location.kind === "file") {
        const path = asText(location.path)
        const op = location.op
        if (path.length === 0 || (op !== "write" && op !== "edit" && op !== "skipped")) continue
        rows = upsert(rows, { key: `file:${path}`, kind: "file", label: path, turnId, op })
      } else if (location.kind === "server") {
        const url = asText(location.url)
        if (url.length === 0) continue
        rows = upsert(rows, { key: `server:${url}`, kind: "server", label: url, turnId, live: true })
      }
    }
    return rows === state.rows ? state : Object.freeze({ rows: Object.freeze(rows) })
  }
  // ‏`refused` رابعُ نهايات الدور: مسارُ السقوط في المحرّك ينتهي به لا بـ`done`.
  // بدونه كان صفُّ الخادم يبقى «حيّاً» إلى الأبد — ثم يصير ادّعاءً كاذباً
  // صريحاً حين يقتل أوّلُ دورٍ تالٍ كلَّ الخوادم بـ`stopAll()` العامّة.
  // (والرفضُ العامّ بلا `turnId` — «نمطٌ غير معروف» وأخواته — لا يقلب شيئاً.)
  if (kind === "done" || kind === "interrupted" || kind === "unresolved" || kind === "refused") {
    if (turnId.length === 0) return state
    let touched = false
    const rows = state.rows.map((row) => {
      if (row.kind !== "server" || row.turnId !== turnId || row.live !== true) return row
      touched = true
      return { ...row, live: false }
    })
    return touched ? Object.freeze({ rows: Object.freeze(rows) }) : state
  }
  return state
}

export interface DeliverableView {
  readonly glyph: string
  readonly label: string
  readonly badge: string
}

const GLYPH: Readonly<Record<string, string>> = Object.freeze({
  write: "✎", edit: "✎", skipped: "⏭", server: "⚙", url: "🌐",
})

export const render = (state: DeliverablesState): DeliverableView[] =>
  state.rows.map((row) => ({
    glyph: row.kind === "file" ? (GLYPH[row.op ?? "write"] ?? "✎") : (GLYPH[row.kind] ?? "•"),
    label: row.label,
    badge: row.kind === "server" ? (row.live === true ? "حيّ" : "أُوقف") : row.op === "skipped" ? "بلا تغيير" : "",
  }))

export * as Deliverables from "./deliverables"
