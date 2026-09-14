/**
 * ذ5 — العدّادُ المحلي: توكنز وزمنٌ ونموذجٌ **لكلّ استدعاء**، على قرص المستخدم وحده.
 *
 * الدفترُ السحابيّ (`token-budget.ts`) يخدم سقفَ السحابة: يسجّل النداءَ السحابيّ وحده بالمحاسبة
 * المتحفّظة (الأعلى بين المبلَّغ والمقدَّر). العدّادُ هنا يخدم **المستخدم**: كلُّ نداءٍ — محلّيٌّ أو
 * سحابيّ — بما **أعلنه المزوّدُ حرفاً** (غيابُه غياب، لا صفر ولا تقدير) وبما حوسب به فعلاً، وبزمنه.
 * الحقيقتان تُكتبان معاً كي يُقاس الفرقُ بينهما بدل أن يُدفن: «مجموعُ العدّاد يطابق ما يعلنه المزوّد»
 * ادّعاءٌ يُفحص من هذا الملفّ لا من ذاكرة أحد.
 *
 * ملفٌّ واحد بسطرٍ لكلّ نداء (JSONL، إلحاقٌ لا قراءة-فتعديل): لا يُرسل، لا يُجمَّع، لا يخرج من الجهاز.
 * السطرُ المشوَّه يُعدّ ولا يُصلَّح ولا يُسقط ما قبله وما بعده.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const METER_ENV = "ABDO_USAGE_METER"

export interface MeterEntry {
  readonly at: string
  readonly provider: string
  readonly model: string
  readonly local: boolean
  readonly note?: string
  /** زمنُ النداء من الإرسال إلى فكّ الردّ — ملّي ثانية. */
  readonly ms: number
  /** ما أعلنه المزوّد حرفاً. */
  readonly reportedInputTokens?: number
  readonly reportedOutputTokens?: number
  readonly reportedCachedInputTokens?: number
  /** ما حوسب به — عينُ ما دخل الدفترَ السحابيّ وعدّادَ الدور. */
  readonly chargedInputTokens: number
  readonly chargedOutputTokens: number
  readonly chargedCachedInputTokens?: number
}

export function meterPath(): string {
  const configured = process.env[METER_ENV]
  if (configured !== undefined && configured.trim().length > 0) return configured
  return join(homedir(), ".abdo", "usage-meter.jsonl")
}

const finiteOrAbsent = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)

/** يُلحق سطراً واحداً؛ الحقولُ المبلَّغة تُكتب إن وُجدت رقماً صالحاً وإلا تُترك — الغيابُ لا يُكتب صفراً. */
export function recordMeterEntry(entry: Omit<MeterEntry, "at">, path = meterPath()): void {
  const line: MeterEntry = {
    at: new Date().toISOString(),
    provider: entry.provider,
    model: entry.model,
    local: entry.local,
    ...(entry.note !== undefined && entry.note.length > 0 ? { note: entry.note } : {}),
    ms: Math.max(0, Math.round(entry.ms)),
    ...(finiteOrAbsent(entry.reportedInputTokens) !== undefined ? { reportedInputTokens: entry.reportedInputTokens } : {}),
    ...(finiteOrAbsent(entry.reportedOutputTokens) !== undefined ? { reportedOutputTokens: entry.reportedOutputTokens } : {}),
    ...(finiteOrAbsent(entry.reportedCachedInputTokens) !== undefined ? { reportedCachedInputTokens: entry.reportedCachedInputTokens } : {}),
    chargedInputTokens: entry.chargedInputTokens,
    chargedOutputTokens: entry.chargedOutputTokens,
    ...(finiteOrAbsent(entry.chargedCachedInputTokens) !== undefined ? { chargedCachedInputTokens: entry.chargedCachedInputTokens } : {}),
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8")
}

const isEntry = (v: unknown): v is MeterEntry => {
  if (typeof v !== "object" || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.at === "string" && typeof e.provider === "string" && typeof e.model === "string" && typeof e.local === "boolean"
    && finiteOrAbsent(e.ms) !== undefined && finiteOrAbsent(e.chargedInputTokens) !== undefined && finiteOrAbsent(e.chargedOutputTokens) !== undefined
}

export interface MeterRead {
  readonly entries: readonly MeterEntry[]
  /** أسطرٌ لم تُفهم — تُعدّ وتُعلَن، لا تُصلَّح ولا تُخفى. */
  readonly malformed: number
}

export function readMeter(path = meterPath()): MeterRead | "absent" {
  if (!existsSync(path)) return "absent"
  const entries: MeterEntry[] = []
  let malformed = 0
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isEntry(parsed)) entries.push(parsed)
      else malformed++
    } catch {
      malformed++
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), malformed })
}

export interface MeterSummary {
  readonly calls: number
  readonly localCalls: number
  readonly cloudCalls: number
  readonly ms: number
  /** المبلَّغ: مجموعُ ما أعلنه المزوّد، وعددُ النداءات التي أعلنت أصلاً. */
  readonly reported: { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number }
  readonly charged: { readonly inputTokens: number; readonly outputTokens: number }
  readonly byModel: Readonly<Record<string, { readonly calls: number; readonly ms: number; readonly chargedInputTokens: number; readonly chargedOutputTokens: number }>>
}

export function meterSummary(entries: readonly MeterEntry[]): MeterSummary {
  let localCalls = 0, ms = 0, rCalls = 0, rIn = 0, rOut = 0, cIn = 0, cOut = 0
  const byModel: Record<string, { calls: number; ms: number; chargedInputTokens: number; chargedOutputTokens: number }> = {}
  for (const e of entries) {
    if (e.local) localCalls++
    ms += e.ms
    if (e.reportedInputTokens !== undefined || e.reportedOutputTokens !== undefined) { rCalls++; rIn += e.reportedInputTokens ?? 0; rOut += e.reportedOutputTokens ?? 0 }
    cIn += e.chargedInputTokens
    cOut += e.chargedOutputTokens
    const key = `${e.provider}/${e.model}`
    const m = byModel[key] ?? (byModel[key] = { calls: 0, ms: 0, chargedInputTokens: 0, chargedOutputTokens: 0 })
    m.calls++; m.ms += e.ms; m.chargedInputTokens += e.chargedInputTokens; m.chargedOutputTokens += e.chargedOutputTokens
  }
  return Object.freeze({
    calls: entries.length, localCalls, cloudCalls: entries.length - localCalls, ms,
    reported: Object.freeze({ calls: rCalls, inputTokens: rIn, outputTokens: rOut }),
    charged: Object.freeze({ inputTokens: cIn, outputTokens: cOut }),
    byModel: Object.freeze(byModel),
  })
}

/** سطرٌ للإنسان — أرقامٌ لا أسماءُ مزوّدين (الأسماءُ في الملفّ على قرصه، لا في سطرٍ يُنسخ). */
export function renderMeterLine(s: MeterSummary): string {
  return `⏲ العدّاد المحلي: ${s.calls} نداء (محلي ${s.localCalls} · سحابي ${s.cloudCalls}) · المحاسَب دخل ${s.charged.inputTokens} خرج ${s.charged.outputTokens} · المبلَّغ في ${s.reported.calls} نداء: دخل ${s.reported.inputTokens} خرج ${s.reported.outputTokens} · الزمن ${s.ms}ms`
}
