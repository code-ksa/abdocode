/** سياسة صرامة القضبان — الهارنس يشتدّ مع ضعف النموذج ويرقّ مع قوّته.
 *
 * قرار المالك (2026-08-31): حلقتنا الصارمة (حِقب، حقن وعي، كتيّبات تُملى،
 * خطة إلزامية) صُمّمت لتعويض نموذجٍ ضعيف — والنموذج القويّ قد تقيّده أكثر
 * مما تخدمه، بينما هارنس OpenCode/OpenHands الرفيع يطلق له العنان. الحلّ
 * ليس اختيار أحد الطرفين بل **سياسة**: صارم للصغيرة، متوسط للمتوسطة،
 * رفيع للقوية — و«تلقائي» يشتقّها (الإعداد الأول في القشرة).
 *
 * أمر المالك (2026-09-06 ليلاً): «لما نموذج قوي نطلق قدرات النموذج، والنموذج الضعيف
 * نشتغل بالفهارس والنظام اللي بنيناه». المقيس ساعتَها: «تلقائي» كان يشتقّ المستوى من
 * نصّ المرجع وحده فصنّف سحابةَ كوين وديب سيك وكيمي وميني ماكس «صارم»، و«رفيع» كان
 * يرسل النصَّ نفسه الذي يرسله «صارم» (9823 حرفاً نظاماً + 2106 دوراً) — الفرقُ
 * جولاتٌ وكتيّبات فقط. فالقاعدتان الآن: (١) **المزوّدُ السحابيّ نموذجٌ قويّ ⇦ رفيع**
 * (إلا الصغيرةَ المعلَنة باسمها mini/nano/lite/≤13B ⇦ متوسط)، والمحلّيُّ بحجمه؛
 * (٢) **الرفيعُ رفيعٌ فعلاً**: بلا مواعظ التدريب في النظام، ولا نثر التفسير في رصد
 * المشروع، ولا طلب «خلاصة الحقبة»، ولا موجز الإطار الدلاليّ والوعي العامّ — ويبقى له
 * عقدُ الأدوات وكتالوجُها وجذرُ المشروع وتعليماتُه والمهاراتُ ولوحُ الخطّة والخريطةُ
 * الباردة واسترجاعُ الحقائق ودروسُ المشروع وسطرُ اقتصاد القراءة (أمر 09-02).
 *
 * قاعدة لا تُساوَم: **حُرّاس الأمن يعملون في كل المستويات** — سرّ التوقيع
 * وحقن SQL وتعطيل TLS والقتل بالاسم والحذف الهدّام ليست «صرامة» بل جودة؛
 * منعُها هو تفوقنا النوعي على الهارنس الرفيع، فلا يرقّ عنها أبداً.
 */

export type RailTier = "strict" | "medium" | "thin"
export type RailSetting = RailTier | "auto"

export interface RailProfile {
  readonly tier: RailTier
  /** حقن خريطة المشروع الباردة في الحقبة الأولى (S1/S9). */
  readonly coldMap: boolean
  /** حقن دفتر وعي الدور في كل حقبة (S1). */
  readonly awarenessBrief: boolean
  /** حقن استرجاع الحقائق الدائمة (S2). */
  readonly factRecall: boolean
  /** إلحاق كتيّبات الأخطاء المحسوبة بالإيصالات الفاشلة (S6). */
  readonly errorPlaybooks: boolean
  /** إلزام خطة السبرنتات وكتابتها آلياً عند الرفض. */
  readonly sprintPlanRequired: boolean
  /** جولات الأدوات لكل حقبة — الرفيع يأخذ عناناً أطول. */
  readonly maxRounds: number
  /** حُرّاس الجودة الاسترشادية (تكرار القدرة، أسلوب write/edit) — لا الأمنية. */
  readonly qualityGuards: boolean
  /** مواعظُ التدريب في نظام الدور (وصفةُ Next، أرقامٌ لا تُختلق، حسابُ التوقّع، «حافظ على الهدف»…) — للضعيف لا للقويّ. */
  readonly coaching: boolean
  /** نثرُ التفسير في رصد المشروع؛ JSON الحقائق يبقى في كلّ مستوى. */
  readonly orientationProse: boolean
  /** طلبُ «خلاصة الحقبة» وحقنُ الخلاصات المخزَّنة (وعي الجلسة) — تعويضُ نافذةٍ ضيّقة. */
  readonly sessionSummary: boolean
  /** موجزُ الإطار الدلاليّ في المدخل (الإطارُ نفسه يُحسب ويُبثّ في كلّ مستوى). */
  readonly semanticBrief: boolean
  /** الوعيُ العامّ العابر للمشاريع في المدخل. */
  readonly generalAwareness: boolean
  readonly reason: string
}

const PROFILES: Record<RailTier, Omit<RailProfile, "reason">> = {
  strict: { tier: "strict", coldMap: true, awarenessBrief: true, factRecall: true, errorPlaybooks: true, sprintPlanRequired: true, maxRounds: 4, qualityGuards: true, coaching: true, orientationProse: true, sessionSummary: true, semanticBrief: true, generalAwareness: true },
  medium: { tier: "medium", coldMap: true, awarenessBrief: true, factRecall: true, errorPlaybooks: true, sprintPlanRequired: false, maxRounds: 8, qualityGuards: true, coaching: true, orientationProse: true, sessionSummary: true, semanticBrief: true, generalAwareness: true },
  // الرفيع: عنانٌ طويل (32 جولة — أمر 09-02) وحقنٌ من الوعي المقيس فقط (خريطة باردة، حقائق، دفتر الدور) بلا مواعظَ
  // ولا نثرٍ ولا خلاصاتٍ ولا موجزاتٍ دلاليّة/عامّة (أمر 09-06). الأمن كاملٌ خارج هذا الملف.
  thin: { tier: "thin", coldMap: true, awarenessBrief: true, factRecall: true, errorPlaybooks: false, sprintPlanRequired: false, maxRounds: 32, qualityGuards: false, coaching: false, orientationProse: false, sessionSummary: false, semanticBrief: false, generalAwareness: false },
}

/** الصغيرةُ السحابيّة المعلَنة باسمها: mini/nano/lite/small/tiny/micro كلمةً مستقلّة، أو distill، أو حجمٌ ≤13B في المرجع. */
const SMALL_CLOUD = /(?:^|[^a-z])(?:mini|nano|lite|small|tiny|micro)(?![a-z])|distill|(?:^|[^0-9.])(?:[1-9]|1[0-3])b(?![0-9a-z])/

/**
 * يشتق المستوى حين يكون الإعداد «تلقائي». `providerLocal` من سجلّ المزوّدين: `false` سحابيّ ⇦ رفيع
 * (إلا الصغيرة المعلَنة ⇦ متوسط)؛ `true` محلّيّ ⇦ بحجمه؛ `undefined` (مزوّدٌ مجهول) ⇦ من نصّ المرجع وحده.
 */
export function tierForModel(modelRef: string, providerLocal?: boolean): RailTier {
  const ref = modelRef.toLowerCase()
  if (providerLocal === false) return SMALL_CLOUD.test(ref) ? "medium" : "thin"
  // القوية المعروفة بمرجعها: عائلات السحابة الكبرى وأحجام ≥70B.
  if (/claude|gpt-[45o]|o[134]-|gemini|deepseek-(?:v3|r1)(?!.*distill)|qwen.*(?:72b|110b|235b)|(?:^|[^0-9])(?:7[02]|110|235)b/.test(ref)) return "thin"
  // المتوسطة: 14B–32B.
  if (/(?:^|[^0-9])(?:1[4-9]|2[0-9]|3[0-4])b|qwq|mixtral/.test(ref)) return "medium"
  // الافتراضي الصارم: الصغيرة المحلية (≤13B) والمجهولة — الغياب تشدّد لا ترخّص.
  return "strict"
}

/** يبني الملفّ النافذ من الإعداد ومرجع النموذج (وكون المزوّد سحابيّاً إن عُرف). اليدويّ يغلب التلقائيّ. */
export function railProfile(setting: RailSetting | undefined, modelRef: string, providerLocal?: boolean): RailProfile {
  const normalized: RailSetting = setting === "strict" || setting === "medium" || setting === "thin" || setting === "auto" ? setting : "auto"
  const tier: RailTier = normalized === "auto" ? tierForModel(modelRef, providerLocal) : normalized
  const origin = providerLocal === false ? "مزوّدٌ سحابيّ" : providerLocal === true ? "مزوّدٌ محلّيّ بحجمه" : "من مرجع النموذج"
  const reason = normalized === "auto" ? `تلقائي: ${tier} — ${origin} «${modelRef}»` : `مثبَّت يدوياً: ${tier}`
  return { ...PROFILES[tier], reason }
}
