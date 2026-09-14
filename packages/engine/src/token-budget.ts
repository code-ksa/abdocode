/** دفتر التوكنز السحابي — سقفٌ صارم قبل أي نداء لمزوّد غير محلي.
 *
 * قرار المالك (2026-08-30): اختبارات النموذج القويّ (qwen-max عبر مفتاح
 * token-plan) لها ميزانية كلّية 10 ملايين توكين عبر كل الجولات — لا لكل
 * جلسة. الدفتر ملفٌ واحد لكل الجهاز، يُقرأ قبل النداء ويُكتب بعده.
 *
 * fail-closed على وجهين («الغياب رفضٌ لا إذن»):
 * 1. دفترٌ موجود لا يُقرأ أو لا يُفهم = مجهول الرصيد ⇦ النداء يُرفض،
 *    لا يُفترض الصفر. (غياب الملف كليّاً حالة أولى مشروعة = صفر منفَق.)
 * 2. قياسُ الاستهلاك الغائب من ردّ المزوّد يُحاسَب بالتقدير المتحفّظ
 *    (الأعلى بين المقدَّر والمبلَّغ) — لا يمرّ نداءٌ بلا ثمن مسجَّل.
 *
 * المحليّ (أولاما) خارج الدفتر — ثمنه كهرباؤنا لا رصيدنا.
 *
 * المحاسبة الواعية بالخبيئة (2026-09-02): المزوّد يعيد عدد توكنز الإدخال
 * المخدومة من خبيئة البادئة (prompt_tokens_details.cached_tokens) وثمنها
 * جزءٌ من ثمن الإدخال العادي. الخام ≠ الكلفة: كلُّ قيدٍ يحمل `cachedInputTokens`
 * اختيارياً، والسقف و«المنفَق» يُحسبان بالتوكنز الفعّالة:
 *   فعّال = إخراج + (إدخال − مخبوء) + مخبوء × الخصم
 * الخصم من `ABDO_CLOUD_CACHE_DISCOUNT` (0..1، الافتراضي 0.25). قيمة 1 = السلوك
 * القديم حرفياً (فعّال = خام) — هذا مفتاح الإطفاء. غياب الحقل = صفر مخبوء،
 * لا وفرٌ مفترض («الغياب رفضٌ لا إذن»). الكسور تُقرَّب للأعلى (تحفّظاً).
 * مفتاح الإعدادات (قاعدة المالك 6): `plugins.cacheAccounting` (الافتراض مفعَّل)؛
 * إطفاؤه يمنع كتابة الحقل أصلاً عبر `chargeableUsage` فتعود القيود خاماً كالقديم.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface LedgerEntry {
  readonly at: string
  readonly provider: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  /** توكنز الإدخال المخدومة من خبيئة المزوّد (جزءٌ من inputTokens). غيابها = صفر. */
  readonly cachedInputTokens?: number
  readonly note?: string
}

export interface Ledger {
  readonly capTokens: number
  readonly entries: LedgerEntry[]
}

export const DEFAULT_CLOUD_CAP_TOKENS = 10_000_000
/** نسبة ثمن الإدخال العادي التي يُحاسَب بها التوكين المخبوء. */
export const DEFAULT_CLOUD_CACHE_DISCOUNT = 0.25

/** خصم الخبيئة من البيئة: عدد في [0, 1]؛ غير ذلك ⇦ الافتراضي. 1 = بلا خصم (السلوك القديم). */
export function cacheDiscount(): number {
  const raw = process.env.ABDO_CLOUD_CACHE_DISCOUNT
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_CLOUD_CACHE_DISCOUNT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_CLOUD_CACHE_DISCOUNT
}

/** خصمٌ صريح خارج [0, 1] (أو غير عدد) لا يُضخّم ولا يُسلّب الثمن — يعود للافتراضي. */
const normalDiscount = (discount: number): number =>
  Number.isFinite(discount) && discount >= 0 && discount <= 1 ? discount : DEFAULT_CLOUD_CACHE_DISCOUNT

/** المخبوء الموثوق في قيد: غائب/غير صالح ⇦ 0؛ ومحصور في [0, inputTokens]. */
export function cachedTokensOf(entry: Pick<LedgerEntry, "inputTokens" | "cachedInputTokens">): number {
  const cached = entry.cachedInputTokens
  if (cached === undefined || !Number.isFinite(cached) || cached <= 0) return 0
  return Math.min(cached, Math.max(entry.inputTokens, 0))
}

/** الثمن الفعّال لقيد واحد — ما يُحاسَب به السقف. */
export function effectiveTokens(entry: Pick<LedgerEntry, "inputTokens" | "outputTokens" | "cachedInputTokens">, discount = cacheDiscount()): number {
  const cached = cachedTokensOf(entry)
  return Math.ceil(entry.outputTokens + (entry.inputTokens - cached) + cached * normalDiscount(discount))
}

/** ما يعيده فكّ ردّ المزوّد من أعداد — الحقول اختيارية لأن المزوّد قد لا يبلّغ. */
export interface ReportedUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
}

/**
 * حدود القيد من الاستعمال المبلَّغ — الجسر الوحيد بين فكّ الردّ والدفتر:
 * الإدخال والإخراج بالمحاسبة المتحفّظة (الأعلى بين المبلَّغ والمقدَّر)، والمخبوء
 * يُمرَّر محصوراً في [0, الإدخال المحاسَب]. غيابه أو فساده أو إطفاء المحاسبة
 * (`plugins.cacheAccounting=false`) ⇦ لا حقل أصلاً، فيُحاسَب القيد كاملاً كالقديم
 * حرفياً — الغياب لا يُكتب صفراً ولا يُخترع.
 */
export function chargeableUsage(usage: ReportedUsage, estimatedInput: number, outputCap: number, cacheAccounting = true): Pick<LedgerEntry, "inputTokens" | "outputTokens" | "cachedInputTokens"> {
  const inputTokens = conservativeTokens(usage.inputTokens, estimatedInput)
  const outputTokens = conservativeTokens(usage.outputTokens, outputCap)
  const cached = usage.cachedInputTokens
  if (!cacheAccounting || cached === undefined || !Number.isFinite(cached) || cached < 0) return { inputTokens, outputTokens }
  return { inputTokens, outputTokens, cachedInputTokens: Math.min(cached, inputTokens) }
}

export interface LedgerSummary {
  readonly calls: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly effectiveTokens: number
  /** المخبوء ÷ الإدخال الموجب، محصورة في [0, 1]؛ صفر حين لا إدخال. */
  readonly cacheHitRate: number
}

/**
 * Safe, aggregate-only view for native shells. It deliberately excludes ledger
 * paths, provider/model names and individual entries: the settings UI needs
 * usage totals, not prompts or account credentials.
 *
 * `capTokens` is AbdoCode's local safety cap. It is not a provider subscription
 * quota, and `remainingTokens` is therefore only the room left under that cap.
 * Local model calls are not recorded in this cloud ledger.
 */
export interface CloudUsageSnapshot {
  readonly status: "available" | "unknown"
  readonly source: "local-cloud-token-ledger"
  readonly localModelsIncluded: false
  readonly capTokens: number
  readonly remainingTokens: number | null
  readonly calls: number | null
  readonly inputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly outputTokens: number | null
  readonly rawTokens: number | null
  readonly effectiveTokens: number | null
  readonly cacheHitRate: number | null
  readonly cacheDiscount: number
}

/** خلاصة الدفتر: الخام والمخبوء والفعّال معاً — الخام يبقى متاحاً لا يُخفى. */
export function ledgerSummary(ledger: Ledger | readonly LedgerEntry[], discount = cacheDiscount()): LedgerSummary {
  const entries = Array.isArray(ledger) ? ledger as readonly LedgerEntry[] : (ledger as Ledger).entries
  let inputTokens = 0, positiveInputTokens = 0, cachedInputTokens = 0, outputTokens = 0, effective = 0
  for (const e of entries) {
    inputTokens += e.inputTokens
    // المخبوء يُحصر لكل قيد ضد إدخاله الموجب، فمقامُ النسبة الإدخال الموجب
    // وحده — قيدٌ سالب (يقبله القارئ) لا يرفع النسبة فوق الواحد.
    positiveInputTokens += Math.max(e.inputTokens, 0)
    cachedInputTokens += cachedTokensOf(e)
    outputTokens += e.outputTokens
    effective += effectiveTokens(e, discount)
  }
  return {
    calls: entries.length, inputTokens, cachedInputTokens, outputTokens, effectiveTokens: effective,
    cacheHitRate: positiveInputTokens > 0 ? Math.min(1, cachedInputTokens / positiveInputTokens) : 0,
  }
}

/** سطرٌ واحد للأحداث: 💳 السحابة: نداءات=N · إدخال=I (مخبوء=C، H%) · إخراج=O · فعّال=E/السقف */
export function renderLedgerLine(summary: LedgerSummary, cap = configuredCloudTokenCap()): string {
  const hit = `${Math.round(summary.cacheHitRate * 100)}%`
  return `💳 السحابة: نداءات=${summary.calls} · إدخال=${summary.inputTokens} (مخبوء=${summary.cachedInputTokens}، ${hit}) · إخراج=${summary.outputTokens} · فعّال=${summary.effectiveTokens}/${cap}`
}

/** خلاصة الدفتر من القرص: غياب الملف = خلاصة صفرية؛ ملفٌ فاسد = مجهول. */
export function readLedgerSummary(path = ledgerPath()): LedgerSummary | "unknown" {
  const ledger = readLedger(path)
  if (ledger === "corrupt") return "unknown"
  return ledgerSummary(ledger === "fresh" ? [] : ledger)
}

/** Aggregate-only cloud usage suitable for the native settings boundary. */
export function cloudUsageSnapshot(path = ledgerPath()): CloudUsageSnapshot {
  const cap = configuredCloudTokenCap()
  const discount = cacheDiscount()
  const summary = readLedgerSummary(path)
  // A JSON ledger can be syntactically valid yet contain impossible negative
  // totals. Do not turn that into a plausible dashboard; preserve fail-closed
  // semantics and report the aggregate as unknown.
  if (summary === "unknown" || summary.calls < 0 || summary.inputTokens < 0 || summary.cachedInputTokens < 0
    || summary.outputTokens < 0 || summary.effectiveTokens < 0
    || !Number.isFinite(summary.cacheHitRate) || summary.cacheHitRate < 0 || summary.cacheHitRate > 1) {
    return {
      status: "unknown", source: "local-cloud-token-ledger", localModelsIncluded: false,
      capTokens: cap, remainingTokens: null, calls: null, inputTokens: null,
      cachedInputTokens: null, outputTokens: null, rawTokens: null,
      effectiveTokens: null, cacheHitRate: null, cacheDiscount: discount,
    }
  }
  return {
    status: "available", source: "local-cloud-token-ledger", localModelsIncluded: false,
    capTokens: cap,
    remainingTokens: Math.max(0, cap - summary.effectiveTokens),
    calls: summary.calls,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    rawTokens: summary.inputTokens + summary.outputTokens,
    effectiveTokens: summary.effectiveTokens,
    cacheHitRate: summary.cacheHitRate,
    cacheDiscount: discount,
  }
}

export function ledgerPath(): string {
  const configured = process.env.ABDO_TOKEN_LEDGER
  if (configured !== undefined && configured.trim().length > 0) return configured
  return join(homedir(), ".abdo", "cloud-token-ledger.json")
}

export function configuredCloudTokenCap(): number {
  const raw = Number(process.env.ABDO_CLOUD_TOKEN_CAP ?? DEFAULT_CLOUD_CAP_TOKENS)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_CLOUD_CAP_TOKENS
}

/** يقرأ الدفتر: غياب الملف = دفتر جديد صفريّ؛ ملفٌ فاسد = مجهول ⇦ رفض. */
function readLedger(path: string): Ledger | "corrupt" | "fresh" {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? "fresh" : "corrupt"
  }
  try {
    const parsed = JSON.parse(raw) as Ledger
    if (!Array.isArray(parsed.entries)) return "corrupt"
    for (const e of parsed.entries) {
      if (!Number.isFinite(e.inputTokens) || !Number.isFinite(e.outputTokens)) return "corrupt"
    }
    return parsed
  } catch {
    return "corrupt"
  }
}

/** المنفَق بالتوكنز الفعّالة (المخبوء بخصمه) — ما يُقارَن بالسقف. قيودٌ بلا حقل مخبوء تُحسب خاماً كما كانت. */
export function spentTokens(path = ledgerPath()): number | "unknown" {
  const ledger = readLedger(path)
  if (ledger === "corrupt") return "unknown"
  if (ledger === "fresh") return 0
  return ledgerSummary(ledger).effectiveTokens
}

/** المنفَق الخام (إدخال + إخراج بلا خصم) — يبقى متاحاً للمقارنة والتقارير. */
export function rawSpentTokens(path = ledgerPath()): number | "unknown" {
  const ledger = readLedger(path)
  if (ledger === "corrupt") return "unknown"
  if (ledger === "fresh") return 0
  const s = ledgerSummary(ledger)
  return s.inputTokens + s.outputTokens
}

export interface BudgetVerdict {
  readonly allowed: boolean
  readonly spent: number | "unknown"
  readonly cap: number
  readonly message?: string
}

/** يُسأل قبل النداء السحابي بتقدير كلفة الطلب القادم (دخل + سقف الخرج). */
export function cloudBudgetVerdict(estimatedRequestTokens: number, path = ledgerPath()): BudgetVerdict {
  const cap = configuredCloudTokenCap()
  const spent = spentTokens(path)
  if (spent === "unknown") {
    return {
      allowed: false, spent, cap,
      message: `دفتر التوكنز السحابي موجود لكنه غير قابل للقراءة (${path}) — الرصيد مجهول والنداء مرفوض؛ أصلح الدفتر أو انقله جانباً بقرار المالك`,
    }
  }
  if (spent + estimatedRequestTokens > cap) {
    return {
      allowed: false, spent, cap,
      message: `ميزانية السحابة استُنفدت: منفَق ${spent} + مقدَّر ${estimatedRequestTokens} > السقف ${cap} — النداء مرفوض؛ رفع السقف قرار المالك (ABDO_CLOUD_TOKEN_CAP)`,
    }
  }
  return { allowed: true, spent, cap }
}

/** يسجّل الثمن بعد النداء — كتابة ذرّية (ملف مؤقت ثم rename). */
export function recordCloudUsage(entry: Omit<LedgerEntry, "at">, path = ledgerPath()): void {
  const existing = readLedger(path)
  if (existing === "corrupt") throw new Error(`دفتر التوكنز فاسد (${path}) — لا تسجيل فوق دفتر مجهول`)
  const ledger: Ledger = existing === "fresh" ? { capTokens: configuredCloudTokenCap(), entries: [] } : existing
  ledger.entries.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 1)}\n`, "utf8")
  renameSync(tmp, path)
}

/** المحاسبة المتحفّظة: المبلَّغ إن وُجد وإلا المقدَّر — والأعلى يفوز. */
export function conservativeTokens(reported: number | undefined, estimated: number): number {
  if (reported === undefined || !Number.isFinite(reported) || reported < 0) return estimated
  return Math.max(reported, 0)
}
