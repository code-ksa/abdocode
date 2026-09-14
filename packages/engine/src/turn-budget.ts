/** سقف إنفاق الدور — سقفٌ بالتوكنز الفعّالة لدورٍ واحد فوق دفتر السحابة العام.
 *
 * الفكرة من anton (`session.py`: `_spend_ceiling_gate`/`_grant_spend_ceiling_grace`
 * وحكم `close_to_done`) بلا نقل كود: anton يعدّ الخام ويحتجز احتياطاً لتسليمٍ يكتبه
 * النموذج؛ نحن نعدّ الفعّال (وحدة سطر 💳 نفسها: `effectiveTokens` بخصم
 * `ABDO_CLOUD_CACHE_DISCOUNT`)، ونفحص قبل كل نداء فلا يخرج نداءٌ فوق السقف، ونسلّم
 * بنصٍّ حتميّ لا يحتاج احتياطاً.
 *
 * العقد (قاعدة المالك 6):
 * - المفتاح `plugins.turnBudget` افتراضه مفعَّل لكنه **خامل** بلا `ABDO_TURN_TOKEN_CAP`:
 *   غياب المتغيّر أو فراغه = لا سقف = لا عدّاد يُبنى أصلاً — السلوك القديم حرفياً.
 * - قيمة مشوَّهة (ليست عدداً صحيحاً موجباً آمناً) = عدّاد في حالة «غير صالح» يرفض كل
 *   نداء سحابي في الدور باسم المتغيّر — سقفُ مالٍ لا يُوسَّع صامتاً إلى افتراض
 *   («الغياب رفضٌ لا إذن»؛ خلافاً لـagentEpochBudget الذي لا يوسّع مالاً).
 * - يُسأل بعد `cloudBudgetVerdict` (السقف العام) لا بدله، ولا يرفعه أبداً.
 * - سماحةٌ واحدة لكل دور، حقبةٌ واحدة، بحجم min(ceil(cap/4), 2×المتنبِّئ) — تُمنح فقط
 *   حين يكون الدور قريباً من الإنجاز بدليل المضيف (`closeToDone`) ونُفّذت أداةٌ واحدة
 *   على الأقل؛ ونداءٌ رُفض وسط الحقبة لا يُسامَح (ما لم يتّسع مرة لن يتّسع ثانية).
 * - المتنبِّئ بوحدة الفحص القبلي نفسها: أكبر طلبٍ مقدَّر سُئل عنه `verdict` (دخلٌ مقدَّر +
 *   سقف الخرج) — لا أكبر نداءٍ فعّال محاسَب؛ فالفعّال بخصم الكاش أصغر بكثير من التقدير،
 *   وبوابةٌ تتنبّأ به تفتح حقبةً يُرفض أول نداءٍ فيها، وسماحةٌ بحجمه لا تتّسع لنداء.
 *   يُؤخذ max(أكبر طلب، أكبر نداء) احتياطاً إن جاء المحاسَب فوق التقدير.
 */
import { type BudgetVerdict, type LedgerEntry, cacheDiscount, effectiveTokens } from "./token-budget"

export const TURN_CAP_ENV = "ABDO_TURN_TOKEN_CAP"
/** السقفُ الافتراضيّ للدور (فعّال) حين لا إعدادَ ولا متغيّرَ بيئة — مقيس 2026-09-13: 150k كان متغيّرَ بيئةٍ على جهاز المطوّر لا افتراضَ منتَج، فجهازُ العميل بلا سقفٍ البتّة. */
export const DEFAULT_TURN_TOKEN_CAP = 400_000

/** عدد صحيح موجب = السقف؛ "invalid" = قيمة مشوَّهة (رفضٌ لا افتراض). */
export type TurnCap = number | "invalid"

/** غياب/فراغ ⇦ undefined (لا سقف)؛ أرقام فقط وعدد صحيح آمن ≥ 1 ⇦ السقف؛ غير ذلك ⇦ "invalid". */
export function turnTokenCap(raw = process.env[TURN_CAP_ENV]): TurnCap | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!/^\d+$/u.test(trimmed)) return "invalid"
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : "invalid"
}

export interface TurnBudgetSnapshot {
  readonly cap: TurnCap
  /** المنفَق بالتوكنز الفعّالة (وحدة 💳). */
  readonly spent: number
  readonly calls: number
  /** أكبر نداءٍ فعّال محاسَب في هذا الدور (معلومة القياس). */
  readonly peakCall: number
  /** أكبر طلبٍ مقدَّر سُئل عنه الفحص القبلي — وحدة البوابة والسماحة (max معه peakCall هو المتنبِّئ). */
  readonly peakRequest: number
  readonly graceTokens: number
  readonly graceUsed: boolean
  readonly graceEpoch?: number
  /** رُفض نداءٌ بهذا السقف (أو السقف غير صالح) — الدور يُسلَّم بصدق. */
  readonly tripped: boolean
  readonly refusals: number
}

export class TurnSpendMeter {
  private readonly cap: TurnCap
  private readonly discount: number
  private readonly rawCap: string
  private spent = 0
  private calls = 0
  private peakCall = 0
  private peakRequest = 0
  private graceTokens = 0
  private graceUsed = false
  private graceEpoch: number | undefined
  /** الحقبة الجارية كما أعلنتها بوابة الحدّ — السماحة سارية في حقبتها وحدها. */
  private epoch: number | undefined
  private tripped = false
  private refusals = 0

  constructor(cap: TurnCap, discount = cacheDiscount(), rawCap = process.env[TURN_CAP_ENV] ?? "") {
    this.cap = cap
    this.discount = discount
    this.rawCap = rawCap
  }

  /** يُشحن من نتيجة `chargeableUsage` نفسها التي تُكتب في الدفتر — وحدةٌ واحدة وحسابٌ واحد. */
  charge(entry: Pick<LedgerEntry, "inputTokens" | "outputTokens" | "cachedInputTokens">): void {
    const cost = effectiveTokens(entry, this.discount)
    this.spent += cost
    this.calls += 1
    if (cost > this.peakCall) this.peakCall = cost
  }

  private activeGrace(): number {
    return this.graceEpoch !== undefined && this.graceEpoch === this.epoch ? this.graceTokens : 0
  }

  /** المتنبِّئ بحجم النداء القادم بوحدة الفحص القبلي: أكبر طلبٍ مقدَّر، ولا يقلّ عن أكبر نداءٍ محاسَب. */
  private predictor(): number {
    return Math.max(this.peakRequest, this.peakCall)
  }

  /** الفحص الصارم قبل النداء السحابي — بالتقدير نفسه الذي يُسأل به سقف السحابة. */
  verdict(estimatedRequestTokens: number): BudgetVerdict {
    if (estimatedRequestTokens > this.peakRequest) this.peakRequest = estimatedRequestTokens
    if (this.cap === "invalid") {
      this.tripped = true
      this.refusals += 1
      return {
        allowed: false, spent: this.spent, cap: 0,
        message: `${TURN_CAP_ENV} غير صالح (${this.rawCap}) — سقف الدور مجهول والنداء السحابي مرفوض؛ صحّح القيمة أو أزلها بقرار المالك`,
      }
    }
    const grace = this.activeGrace()
    if (this.spent + estimatedRequestTokens > this.cap + grace) {
      this.tripped = true
      this.refusals += 1
      return {
        allowed: false, spent: this.spent, cap: this.cap,
        message: `سقف الدور استُنفد: منفَق ${this.spent} + مقدَّر ${estimatedRequestTokens} > سقف الدور ${this.cap}${grace > 0 ? ` + سماحة ${grace}` : ""} — النداء مرفوض؛ التقدم محفوظ في نقطة الحفظ، والاستمرار قرار المالك (${TURN_CAP_ENV} أو دور جديد بـ«اكمل»)`,
      }
    }
    return { allowed: true, spent: this.spent, cap: this.cap }
  }

  /** بوابة حدّ الحقبة: المتنبِّئ (أكبر طلبٍ مقدَّر) هو حجم النداء القادم؛ تمرير الحقبة يُعلنها جاريةً
   * (فتسري سماحتها أو تنقضي). سقفٌ غير صالح يُنهك البوابة فقط بعد أن رُفض به نداءٌ سحابي فعلاً —
   * دورٌ محلّي لم يطلب السحابة قطّ لا شيء يُسقَّف فيه، فلا يُوقَف بخطأٍ في متغيّرٍ لا يمسّه. */
  gate(epoch?: number): "open" | "exhausted" {
    if (epoch !== undefined) this.epoch = epoch
    if (this.cap === "invalid") return this.tripped ? "exhausted" : "open"
    return this.spent + this.predictor() > this.cap + this.activeGrace() ? "exhausted" : "open"
  }

  /** سماحة واحدة لكل دور: min(ceil(cap/4), max(2×المتنبِّئ, 1))، لحقبةٍ واحدة. صفر إن استُهلكت أو السقف غير صالح.
   * المضيف يمنحها فقط إن أعادت `gate` إلى «open» — سماحةٌ لا تتّسع لنداءٍ واحد بحجم المتنبِّئ توقّفٌ صادق لا سماحة. */
  grantGrace(epoch: number): number {
    if (this.cap === "invalid" || this.graceUsed) return 0
    this.graceUsed = true
    this.graceEpoch = epoch
    this.epoch = epoch
    this.graceTokens = Math.min(Math.ceil(this.cap / 4), Math.max(2 * this.predictor(), 1))
    return this.graceTokens
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      cap: this.cap, spent: this.spent, calls: this.calls, peakCall: this.peakCall, peakRequest: this.peakRequest,
      graceTokens: this.graceTokens, graceUsed: this.graceUsed,
      ...(this.graceEpoch === undefined ? {} : { graceEpoch: this.graceEpoch }),
      tripped: this.tripped, refusals: this.refusals,
    }
  }
}

export interface CloseToDoneEvidence {
  /** آخر نقطة حفظ معلَّقة على فحص قبول حتمي (typecheck/build/audit/test) يُنفّذه المضيف. */
  readonly probePending: boolean
  /** عدد السبرنتات المفتوحة في ABDO-SPRINTS.md؛ undefined = لا ملف = لا دليل. */
  readonly openSprints: number | undefined
  /** إيصالات الأدوات في هذا الدور — «لا تُسامَح دورٌ لم ينفّذ شيئاً». */
  readonly receipts: number
}

/** دليل المضيف لا تقرير النموذج: إيصالٌ واحد على الأقل و(فحص معلَّق أو سبرنت واحد باقٍ). */
export function closeToDone(input: CloseToDoneEvidence): boolean {
  return input.receipts > 0 && (input.probePending || input.openSprints === 1)
}

/** السقف نصّاً عربياً واحداً في كل سطرٍ يذكره — لا يتسرّب الحرفي الإنجليزي "invalid" إلى الأثر أو الجواب. */
export function renderCap(cap: TurnCap): string {
  return cap === "invalid" ? "غير صالح" : String(cap)
}

/** سطر ⏱ لكل حقبة — مستقل عن سطر 💳 (الدفتر العام) ولا يُغيّره. */
export function renderTurnBudgetLine(s: TurnBudgetSnapshot, epoch: number): string {
  return `⏱ سقف الدور (حقبة ${epoch}): فعّال=${s.spent}/${renderCap(s.cap)} · نداءات=${s.calls} · أكبر نداء=${s.peakCall} · سماحة=${s.graceUsed ? `${s.graceTokens} (مستعملة)` : "—"}`
}
