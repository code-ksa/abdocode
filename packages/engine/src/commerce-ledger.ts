/**
 * ذ6 — الدفترُ التجاريّ: شراءٌ وبيعٌ وهامشٌ **بالهللات**، وحصّةٌ تنتهي برسالةٍ لا بخطأ.
 *
 * القاعدةُ الحاكمة: **سعرٌ غائبٌ يمنع البيع** (fail-closed) ولا يُقدَّر. بيعُ ذكاءٍ بسعرٍ مخمَّنٍ خسارةٌ صامتةٌ تظهر
 * بعد شهر، أو غبنٌ للمشترك — وكلاهما لا يُصلحه اعتذار. فحين ينقص سعرُ شراءِ نموذجٍ استُعمل فعلاً، يعود الحسابُ
 * `unavailable` باسم النموذج الناقص، ولا رقمَ يُعرض ولا فاتورةَ تُبنى.
 *
 * وحدةُ الحساب **هللة** (١/١٠٠ ريال) عدداً صحيحاً: العائمُ يجمع فروقاً تظهر في الشهر الثاني. الأسعارُ تُعطى
 * «هللةً لكلّ مليون توكن» كما تنشرها المزوّدات، والضربُ يقع في الأعداد الصحيحة ثمّ يُقرَّب بالتقريب النصفيّ لأعلى
 * مرّةً واحدة عند الحدّ — لا تقريبَ وسطيّاً يتراكم.
 *
 * وتبديلُ المزوّد يضبط **تكلفتنا وحدها**: البيعُ من خطّة المشترك لا من النموذج الذي خدمه، وإلا صار المشتركُ يدفع
 * أكثر لأنّنا اخترنا نموذجاً أغلى — قرارُنا لا يُحمَّل عليه.
 *
 * الوحدة **نقيّة**: لا قرص ولا شبكة ولا ساعة ولا إعدادات. الأسعارُ تدخل وسيطاً، والقارئُ في `cli.ts` وحده.
 */

/** سعرُ نموذجٍ واحد — هللاتٌ لكلّ مليون توكن، كما تنشرها المزوّدات. */
export interface ModelPrice {
  /** `provider/model` كما في العدّاد. */
  readonly ref: string
  /** هللةٌ لكلّ مليون توكنِ دخل. */
  readonly buyInPerMillion: number
  /** هللةٌ لكلّ مليون توكنِ خرج. */
  readonly buyOutPerMillion: number
  /** دخلٌ مخبَّأ (إن أعلنه المزوّد) — الغيابُ يعني «كالدخل العاديّ» لا «مجّاناً». */
  readonly buyCachedInPerMillion?: number
}

/** خطّةُ المشترك: ما نبيعه به، وحصّتُه. البيعُ مستقلٌّ عن النموذج الذي خدم. */
export interface SubscriberPlan {
  readonly id: string
  /** هللةٌ لكلّ مليون توكنٍ نبيعها للمشترك (دخلاً وخرجاً بسعرٍ واحد — بساطةٌ مقصودة تُشرح للمشترك). */
  readonly sellPerMillion: number
  /** سقفُ الحصّة بالهللات (ما نبيعه)، أو `undefined` لبلا سقف. */
  readonly quotaHalalas?: number
}

/** استهلاكُ نموذجٍ واحد كما يخرج من العدّاد المحلّي. */
export interface ModelUsage {
  readonly ref: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
}

export type LedgerResult =
  | Readonly<{ kind: "ok"; buyHalalas: number; sellHalalas: number; marginHalalas: number; tokens: number; perModel: readonly Readonly<{ ref: string; buyHalalas: number; tokens: number }>[] }>
  /** سعرٌ ناقصٌ لنموذجٍ استُعمل فعلاً — لا بيعَ ولا تقدير. */
  | Readonly<{ kind: "unavailable"; why: string; missing: readonly string[] }>

const MILLION = 1_000_000

/** ضربٌ صحيحٌ بتقريبٍ نصفيٍّ لأعلى مرّةً واحدة — لا عائمَ يتراكم عبر آلاف النداءات. */
const halalasFor = (tokens: number, perMillion: number): number => Math.round((tokens * perMillion) / MILLION)

/**
 * يحسب الأربعة: شراؤنا، وبيعُنا، والهامش، ومجموعُ التوكينات. سعرُ شراءٍ ناقصٌ لنموذجٍ **استُعمل** ⇦ `unavailable`.
 * والنموذجُ الذي لم يُستعمل لا يلزمه سعر: الغيابُ يمنع ما يُبنى عليه لا ما لا يمسّه.
 */
export function ledgerFor(usage: readonly ModelUsage[], prices: readonly ModelPrice[], plan: SubscriberPlan): LedgerResult {
  const table = new Map(prices.map((p) => [p.ref, p] as const))
  const used = usage.filter((u) => u.inputTokens > 0 || u.outputTokens > 0 || (u.cachedInputTokens ?? 0) > 0)
  const missing = [...new Set(used.filter((u) => !table.has(u.ref)).map((u) => u.ref))]
  if (missing.length > 0) {
    return Object.freeze({
      kind: "unavailable",
      why: `لا سعرَ شراءٍ لـ${missing.join("، ")} — البيعُ ممتنع: سعرٌ مخمَّنٌ خسارةٌ صامتة أو غبنٌ للمشترك. أضِف السعر في الإعدادات ثمّ أعد الحساب.`,
      missing: Object.freeze(missing),
    })
  }
  let buy = 0, tokens = 0
  const perModel: { ref: string; buyHalalas: number; tokens: number }[] = []
  for (const u of used) {
    const price = table.get(u.ref)!
    const cached = u.cachedInputTokens ?? 0
    // الدخلُ المخبَّأ بسعره إن أُعلن، وإلا بسعر الدخل — «مجّاناً» ادّعاءٌ لا يقوله المزوّد.
    const modelBuy =
      halalasFor(Math.max(0, u.inputTokens - cached), price.buyInPerMillion) +
      halalasFor(cached, price.buyCachedInPerMillion ?? price.buyInPerMillion) +
      halalasFor(u.outputTokens, price.buyOutPerMillion)
    const modelTokens = u.inputTokens + u.outputTokens
    buy += modelBuy
    tokens += modelTokens
    perModel.push({ ref: u.ref, buyHalalas: modelBuy, tokens: modelTokens })
  }
  // البيعُ من خطّة المشترك لا من النموذج الذي خدمه: تبديلُنا يضبط تكلفتَنا وحدها.
  const sell = halalasFor(tokens, plan.sellPerMillion)
  return Object.freeze({ kind: "ok", buyHalalas: buy, sellHalalas: sell, marginHalalas: sell - buy, tokens, perModel: Object.freeze(perModel.map((m) => Object.freeze(m))) })
}

export type QuotaVerdict =
  | Readonly<{ kind: "open"; usedHalalas: number; remainingHalalas?: number }>
  /** بلغ السقف: **رسالةٌ لا خطأ** — الدورُ الجاري يُكمل، والتالي يُمنع بسببٍ مفهوم. */
  | Readonly<{ kind: "ceiling"; usedHalalas: number; message: string }>

/**
 * حكمُ الحصّة. القاعدة: عند السقف **رسالةٌ لا خطأ**، ولا يضيع دورٌ نصف منفَّذ — فالحكمُ يُسأل **قبل** بدء دورٍ جديد،
 * ودورٌ بدأ يُكمل بما بدأ به. (المنعُ الفوريّ وسط الدور يترك ملفّاً نصفَ مكتوبٍ وإيصالاً بلا نتيجة.)
 */
export function quotaVerdict(soldHalalas: number, plan: SubscriberPlan): QuotaVerdict {
  if (plan.quotaHalalas === undefined) return Object.freeze({ kind: "open", usedHalalas: soldHalalas })
  if (soldHalalas < plan.quotaHalalas) {
    return Object.freeze({ kind: "open", usedHalalas: soldHalalas, remainingHalalas: plan.quotaHalalas - soldHalalas })
  }
  return Object.freeze({
    kind: "ceiling",
    usedHalalas: soldHalalas,
    message: `بلغتَ حصّةَ خطّتك (${(plan.quotaHalalas / 100).toFixed(2)} ريال). الدورُ الجاري يكتمل، والدورُ التالي يحتاج ترقيةً أو تجديدَ الحصّة — لا شيءَ ضاع.`,
  })
}

/** سطرٌ للإنسان بالريالات: الأربعةُ كما هي، وبلا نسبةٍ مئويّةٍ تُخفي الصغيرَ في الكبير. */
export function renderLedgerLine(result: LedgerResult): string {
  if (result.kind === "unavailable") return `💱 الدفتر: ${result.why}`
  const riyal = (h: number): string => `${(h / 100).toFixed(2)} ريال`
  return `💱 الدفتر: ${result.tokens} توكن · شراؤنا ${riyal(result.buyHalalas)} · بيعُنا ${riyal(result.sellHalalas)} · الهامش ${riyal(result.marginHalalas)}`
}
