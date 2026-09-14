/**
 * S13.3 — الوعي العام (عبدو): ذاكرةٌ مركزيّةٌ عابرةٌ للمشاريع في دليل التثبيت.
 *
 * الطبقات الثلاث الأولى مملوكةٌ لمشروعٍ واحد: وعي الدور، وخلاصة الجلسة،
 * و`ABDO-AWARENESS.md` في جذر المشروع. هذه الطبقة الرابعة **مشتركة**: تسكن
 * `<دليل التثبيت>` لا جذرَ مشروع، ويقرؤها كلُّ مشروعٍ يفتحه المشغّل. ومن هنا
 * جاء أخطرُ ما في هذا الملفّ كلّه:
 *
 * > درسٌ تعلّمناه داخل مشروع عميلٍ لا يجوز أن يحمل معه اسمَ ذلك العميل ولا
 * > مساراته ولا مضيفاته ولا سطراً من محتواه إلى مشروع عميلٍ آخر. تسريبٌ هنا
 * > يسلّم بيانات عميلٍ لعميل — وهو أسوأ عطلٍ يمكن أن يصيب هذا المنتج.
 *
 * فالترقية إلى هذا المخزن **قرارٌ مقنَّن لا تراكمٌ آليّ**: قاعدةُ الترقية
 * مكتوبةٌ نصّاً في `PROMOTION_RULE` (يطبعها أمرُ المشرف)، ومختبَرةٌ بندأً
 * بنداً، وكلُّ مرشّحٍ يمرّ بها كاملةً قبل أن تُكتب بايتٌ واحدة.
 *
 * وأقوى قضيبٍ فيها ليس فحصاً بل **شكلُ السجلّ نفسه**: لا حقلَ في
 * `GeneralLesson` يسع هويّةَ مشروع — لا اسماً ولا مساراً ولا معرّفاً ولا
 * بصمةً. عددُ مرّات الترقية يُعدّ، ومن أين جاءت لا يُخزَّن أصلاً. ما لا
 * يوجد له حقلٌ لا يتسرّب.
 *
 * الوحدة **خالصة**: لا `node:` ولا قرص ولا ساعة — المضيف يقرأ النصّ ويمرّره،
 * ويكتب ما تعيده. الحجب بمفردات `secret-command-guard` نفسها (لا تعبيرَ ثانياً).
 */
import { PLAYBOOKS } from "./error-playbooks"
import { normalizeArabic } from "./front-gate"
import { redactSecretValues, residualSecretMatches, sweepResidualSecrets } from "./secret-command-guard"

/** الملفّ في دليل التثبيت — لا في جذر أيّ مشروع، أبداً. */
export const GENERAL_STORE_FILE = "abdo-general-awareness.json"
export const GENERAL_STORE_VERSION = 1
/** سقفُ الدروس؛ الطردُ حتميّ (الأقلّ ترقيةً ثمّ الأقدم ثمّ المفتاح). */
export const GENERAL_STORE_CAP = 120
export const GENERAL_LESSON_MIN_CHARS = 12
export const GENERAL_LESSON_MAX_CHARS = 700

/**
 * أصنافُ الدرس العامّ — مغلقةٌ بنصّ البرنامج: «كتيّبات معتمَدة بعد تأهيل،
 * أنماط حزم، فخاخ بيئة». لا صنفَ حرّاً: نصٌّ بلا صنفٍ من هذه لا يُرقّى.
 */
export const GENERAL_CLASSES = Object.freeze(["playbook", "package_pattern", "env_trap"] as const)
export type GeneralClass = (typeof GENERAL_CLASSES)[number]

export const GENERAL_CLASS_LABEL: Readonly<Record<GeneralClass, string>> = Object.freeze({
  playbook: "كتيّب معتمَد",
  package_pattern: "نمط حزم",
  env_trap: "فخّ بيئة",
})

export interface GeneralLesson {
  /** مفتاحٌ حتميّ من النصّ المطويّ — به تكون الترقية فاعلاً واحداً مهما تكرّرت. */
  readonly key: string
  readonly cls: GeneralClass
  /** النصّ بعد الحجب — هو ما يُكتب على القرص. */
  readonly text: string
  /** كم مرّةً رُقّي هذا الدرس. **لا** «من أين» — لا حقلَ لذلك في السجلّ. */
  readonly seen: number
  readonly firstSeen: number
  readonly lastSeen: number
}

/**
 * حقولُ السجلّ كاملةً. اختبارٌ يثبت أن هذه هي كلُّ الحقول: إضافةُ حقلٍ يسع
 * هويّةَ مشروع (اسم، مسار، معرّف، بصمة) تسقطه — القضيب في الشكل لا في الفحص.
 */
export const GENERAL_LESSON_FIELDS: readonly string[] = Object.freeze(["key", "cls", "text", "seen", "firstSeen", "lastSeen"])

export interface GeneralStore {
  readonly version: number
  readonly lessons: readonly GeneralLesson[]
}

export const EMPTY_GENERAL_STORE: GeneralStore = Object.freeze({ version: GENERAL_STORE_VERSION, lessons: Object.freeze([]) })

/**
 * قاعدةُ الترقية — مُعلَنةٌ نصّاً لأنها عقدٌ لا تفصيلُ تنفيذ. يطبعها
 * `awareness` للمشغّل، ويثبت اختبارٌ أن كلّ بندٍ منها مُنفَّذ.
 */
export const PROMOTION_RULE: readonly string[] = Object.freeze([
  `1. صنفٌ مغلق: الصنف من ${GENERAL_CLASSES.join("/")} وحدها — لا نصَّ حرّاً ولا صنفاً يخترعه النموذج.`,
  "2. مصدرٌ مقنَّن: المرشّح نصٌّ يملكه المنتج (كتيّب معتمَد بعد تأهيله بجولةٍ مكتملة) لا نصُّ مشروعٍ ولا قولُ نموذج.",
  "3. حجبٌ قبل الكتابة: كلّ مرشّح يمرّ بـredactSecretValues ثمّ الكنس sweepResidualSecrets، والمحجوب هو ما يُخزَّن؛ والكنس يستبدل كلّ بقيّةٍ تشبه سرّاً، والفحص بعده قضيبٌ مغلق لا مسارٌ حيّ.",
  `4. شكلٌ مسقوف: سطرٌ واحد بين ${GENERAL_LESSON_MIN_CHARS} و${GENERAL_LESSON_MAX_CHARS} محرفاً.`,
  "5. لا رمزَ يعرّف مشروعاً: مسار مطلق أو نسبيّ، رابط، مضيف، IP، منفذ، بريد، معرّف جلسة/دور/حقيقة، خلط أبجديّات، أو أيّ رمزٍ من رموز مشروع الدور — رفضٌ بالاسم. والفحص كلّه على النصّ مطويّاً بمفردة المنتج (بلا محارف صفريّة ولا أرقام هنديّة ولا متشابهات سيريليّة)، فلا يعبر الاسمُ متنكّراً.",
  `6. مخزنٌ مسقوف بطردٍ حتميّ: ${GENERAL_STORE_CAP} درساً، ويُطرد الأقلّ ترقيةً ثمّ الأقدم ثمّ الأسبق مفتاحاً.`,
  "7. فاعلٌ واحد (idempotent): المفتاح نفسه يزيد العدّاد ولا يكرّر سطراً ولا يبدّل نصّاً استقرّ.",
  "8. لا هويّةَ مشروعٍ في الشكل: حقولُ السجلّ (key/cls/text/seen/firstSeen/lastSeen) لا تسع اسماً ولا مساراً ولا بصمةً لمصدر الدرس.",
])

// ---------------------------------------------------------------------------
// الطيّ — مفردةٌ واحدة يستعملها المفتاح والبحث معاً
// ---------------------------------------------------------------------------

/**
 * طيُّ الرسم — **بمفردة المنتج الواحدة** `normalizeArabic`، لا بنسخةٍ ثانية.
 *
 * كان هنا طيٌّ مكتوبٌ باليد يفعل ثلثَ ما تفعله المفردة الأصليّة، فسقط القضيبُ
 * العابر بمحرفٍ صفريٍّ واحد: «acme​-shop» لا يطابق «acme-shop» عند أيّ
 * مقارنةٍ على نصٍّ لم تُنزع منه المحارف غير المرئيّة، و«٤٣١٠» ليست «4310»
 * عند `\d`، و«асme» السيريليّة ليست «acme». والمفردة الأصليّة تنزع الصفريّات
 * والاتّجاهيّات، وتطوي الأرقام الهنديّة إلى لاتينيّة، وتردّ المتشابهات
 * السيريليّة — وهي موضوعةٌ أصلاً لهذا الصنف من التحايل (الفريق الأحمر أسقط
 * حارساً سابقاً بمحرفٍ صفريّ واحد).
 *
 * وما تزيده هذه الدالّة فوقها: خفضُ الحالة وضغطُ الفراغ — ليستقرّ المفتاح
 * فلا يتكرّر السطر نفسه كلّ جولة حتى يطرد السقفُ معرفةً حقيقيّة.
 */
export const foldText = (input: string): string =>
  normalizeArabic(typeof input === "string" ? input : "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()

// ---------------------------------------------------------------------------
// القضيب العابر — رموزٌ تعرّف مشروعاً
// ---------------------------------------------------------------------------

/**
 * كواشفُ الرموز المعرِّفة. الاتّجاه الآمن هو **الرفضُ الزائد**: درسٌ رُفض
 * خسارةُ معرفة، ودرسٌ سُرِّب تسليمُ بيانات عميلٍ لعميل. فلا استثناءَ ولا
 * قائمةَ بيضاء «للمسارات العامّة» — ثقبٌ واحدٌ في هذا الجدار يكفي.
 */
const IDENTIFYING: readonly { readonly label: string; readonly re: RegExp }[] = Object.freeze([
  Object.freeze({ label: "مسار مطلق", re: /[A-Za-z]:[\\/]|\\\\[\p{L}\p{N}_.-]/u }),
  // المقاطع `\p{L}` لا `[A-Za-z]`: «مجلّد/العميل» مسارٌ يعرّف مثل «app/page».
  Object.freeze({ label: "مسار", re: /[\p{L}\p{N}_.@~-]+[\\/][\p{L}\p{N}_.@~-]+/u }),
  Object.freeze({ label: "رابط", re: /[A-Za-z][A-Za-z0-9+.-]*:\/\//u }),
  // **بنيويّ لا قائمةَ نطاقاتٍ عليا**: القائمة المغلقة كانت تفوّت
  // `db.acme-internal.example` وكلَّ نطاقٍ لم يخطر ببال كاتبها، والقائمةُ
  // البيضاء في جدارٍ كهذا ثقبٌ بالتعريف. الشرط: مقطعٌ يبدأ بحرف، وكلُّ مقطعٍ
  // بعد النقطة فيه حرفٌ واحد على الأقلّ — فلا يصير «الإصدار 1.5» مضيفاً.
  // والاسمُ صادق: `db.acme-internal.example` و`sys.path.insert` شكلٌ واحد لا
  // يفرّقه فحصٌ بنيويّ، فيُسمّى الرفض بما يراه — لا يدّعي «مضيفاً» عن يقين.
  Object.freeze({ label: "مضيف/اسم منقَّط", re: /[\p{L}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]*[\p{L}][\p{L}\p{N}-]*)+/u }),
  Object.freeze({ label: "عنوان IP", re: /\d{1,3}(?:\.\d{1,3}){3}/u }),
  Object.freeze({ label: "منفذ", re: /:\d{2,5}(?!\d)/u }),
  Object.freeze({ label: "بريد", re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u }),
  // `s-<حقبة>` شكلُ معرّف الجلسة في المحرّك. الحرفُ العاري `s` قبل شرطةٍ لا
  // يُقبل كاشفاً: «js-based» و«css-modules» ليسا معرّفَي جلسة، ورفضُهما
  // رفضٌ زائدٌ بلا مقابل — والرقمُ العشريّ هو ما يميّز المعرّف حقاً.
  Object.freeze({ label: "معرّف جلسة/دور/حقيقة", re: /(?:turn|session|fct)[:_-][A-Za-z0-9-]{4,}|(?<![A-Za-z0-9])s-\d{10,}/iu }),
  // ما بقي مختلطاً بعد الطيّ: حرفٌ لاتينيّ ملاصقٌ لسيريليّ أو يونانيّ ليس
  // كلمةً في لغةٍ — إنه اسمٌ مموَّه بمتشابهٍ لم تطوِه المفردة. رفضٌ بالاسم.
  Object.freeze({ label: "خلط أبجديّات", re: /[A-Za-z][Ͱ-ϿЀ-ӿ]|[Ͱ-ϿЀ-ӿ][A-Za-z]/u }),
])

/**
 * رموزُ مشروع الدور كما تُشتقّ من مجلَّده — كلُّ مقطعٍ في مساره بطول ≥ 4
 * والاسمُ الأخير مهما قصر. تُمرَّر من المضيف: الوحدة خالصةٌ لا تعرف قرصاً.
 */
export const projectTokensOf = (projectDir: string): readonly string[] => {
  const raw = typeof projectDir === "string" ? projectDir : ""
  const segments = raw.split(/[\\/]+/u).map((s) => s.trim()).filter((s) => s.length > 0 && !/^[A-Za-z]:$/u.test(s))
  const base = segments[segments.length - 1]
  const picked = segments.filter((s) => s.length >= 4)
  if (base !== undefined && !picked.includes(base)) picked.push(base)
  return Object.freeze([...new Set(picked.map(foldText))].filter((s) => s.length > 0))
}

/**
 * يعيد أسبابَ الرفض المسمّاة، أو مصفوفةً فارغة. لا يرمي أبداً، ولا يعيد
 * «ربّما» — الغياب هنا يعني «لم يُكتشف رمزٌ معرِّف»، والقرار للمنادي.
 */
export const projectIdentifyingTokens = (text: string, projectTokens: readonly string[] = []): readonly string[] => {
  const body = typeof text === "string" ? text : ""
  const reasons: string[] = []
  // **الكشفُ على المطويّ لا على الخام**: الكاشفُ الذي يقرأ الخام يعمى عن
  // «acme​-shop» (محرفٌ صفريّ) و«١٢٧.٠.٠.١» و«асme» — وهي عينُ الاسم الذي
  // رفضه بحرفيّته قبل سطر. طيٌّ واحد ثمّ كلُّ الفحوص فوقه.
  const folded = foldText(body)
  for (const detector of IDENTIFYING) {
    const hit = detector.re.exec(folded)
    if (hit !== null) reasons.push(`${detector.label} «${hit[0].slice(0, 40)}»`)
  }
  // **الفواصل تُطوى أيضاً**: قيس بالمشرف 2026-09-03 أن «almanara-clinic» يعبر
  // إذا كُتب «almanara clinic» — شرطةٌ صارت فراغاً فسقطت المطابقة الحرفية،
  // والاسمُ يبقى معرِّفاً لمن يقرأه. فالمقارنة تجري مرّتين: على المطويّ كما هو،
  // وعلى نسخةٍ تُوحَّد فيها الفواصل (- _ . فراغ) إلى فراغٍ واحد في الطرفين.
  const loosened = folded.replace(/[-_.\s]+/gu, " ")
  for (const token of projectTokens) {
    if (typeof token !== "string" || token.length === 0) continue
    const foldedToken = foldText(token)
    const loosenedToken = foldedToken.replace(/[-_.\s]+/gu, " ").trim()
    const hit = folded.includes(foldedToken) || (loosenedToken.length >= 4 && loosened.includes(loosenedToken))
    if (hit) reasons.push(`اسم من مشروع الدور «${token.slice(0, 40)}»`)
  }
  return Object.freeze(reasons)
}

// ---------------------------------------------------------------------------
// الترقية
// ---------------------------------------------------------------------------

export interface PromotionCandidate {
  readonly cls: string
  readonly text: string
}

export interface PromotionContext {
  readonly projectTokens: readonly string[]
  readonly now: number
}

export type PromotionReason = "class" | "shape" | "secret" | "project-token"

export interface PromotionAccepted {
  readonly ok: true
  readonly store: GeneralStore
  readonly key: string
  /** false = المفتاح كان موجوداً؛ زاد العدّاد ولم يُضَف سطر. */
  readonly added: boolean
  /** false = لا بايتَ تغيّر على القرص (نصٌّ ونسخةٌ وعدّادٌ كما هي). */
  readonly changed: boolean
  readonly redactions: number
  readonly evicted: readonly string[]
}

export interface PromotionRefused {
  readonly ok: false
  readonly reason: PromotionReason
  readonly refused: string
}

export type PromotionResult = PromotionAccepted | PromotionRefused

const isGeneralClass = (value: unknown): value is GeneralClass =>
  typeof value === "string" && (GENERAL_CLASSES as readonly string[]).includes(value)

/** الطردُ الحتميّ: الأقلّ ترقيةً، ثمّ الأقدم، ثمّ الأسبق مفتاحاً. */
const evictionOrder = (a: GeneralLesson, b: GeneralLesson): number =>
  a.seen !== b.seen ? a.seen - b.seen : a.firstSeen !== b.firstSeen ? a.firstSeen - b.firstSeen : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/**
 * يرقّي مرشّحاً واحداً. الترتيب مقصود: الصنف ⇒ الحجب ⇒ الشكل على المحجوب ⇒
 * الرمز المعرِّف ⇒ المفتاح ⇒ الدمج ⇒ الطرد.
 *
 * **الحجب قبل المفتاح** — الدرسُ المدفوع نفسه في `project-awareness`: مفتاحٌ
 * محسوبٌ قبل الحجب لا يطابق ما استقرّ بعده، فيتكرّر السطر كلّ جولة حتى يطرد
 * السقفُ معرفةً حقيقيّة.
 *
 * **الشكلُ على المحجوب** — الحجبُ يطيل النصّ أحياناً («مُحجَّب» أطولُ من
 * مفتاحٍ قصير)، فقياسُ السقف على الخام يقبل ما لا يسع بعد الحجب.
 */
export const promoteLesson = (store: GeneralStore, candidate: PromotionCandidate, ctx: PromotionContext): PromotionResult => {
  const cls = candidate?.cls
  if (!isGeneralClass(cls)) {
    return Object.freeze({ ok: false as const, reason: "class" as const, refused: `رُفضت الترقية: صنفٌ غير معتمَد «${String(cls).slice(0, 40)}» — المسموح ${GENERAL_CLASSES.join("، ")}` })
  }
  const raw = (typeof candidate.text === "string" ? candidate.text : "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim()
  const precise = redactSecretValues(raw)
  let redactions = precise.redactions
  let text = precise.text
  if (residualSecretMatches(text).length > 0) {
    const swept = sweepResidualSecrets(text)
    redactions += swept.redactions
    text = swept.text
  }
  // قضيبٌ **مغلق** لا مسارٌ حيّ: الكنس يستبدل عينَ ما يبلّغ عنه الفحص، فهذا
  // الفرع لا يقع اليوم بحالٍ — ويبقى لأن تغييراً في الكنس غداً يجب أن يوقف
  // الكتابة لا أن يمرّرها. اختبارٌ يثبت الأمرين معاً حتى لا يُقرأ نصُّ
  // القاعدة على أن هنا رفضاً يجري (والقاعدة نفسها تقولها بنصّها الآن).
  if (residualSecretMatches(text).length > 0) {
    return Object.freeze({ ok: false as const, reason: "secret" as const, refused: "رُفضت الترقية: بقي ما يشبه سرّاً بعد الحجب — لا يُكتب في المخزن العام" })
  }
  if (text.length < GENERAL_LESSON_MIN_CHARS || text.length > GENERAL_LESSON_MAX_CHARS) {
    return Object.freeze({ ok: false as const, reason: "shape" as const, refused: `رُفضت الترقية: الطول ${text.length} خارج [${GENERAL_LESSON_MIN_CHARS}, ${GENERAL_LESSON_MAX_CHARS}]` })
  }
  const identifying = projectIdentifyingTokens(text, ctx.projectTokens)
  if (identifying.length > 0) {
    return Object.freeze({ ok: false as const, reason: "project-token" as const, refused: `رُفضت الترقية: يحمل ما يعرّف مشروعاً (${identifying.join("، ")})` })
  }
  const key = foldText(text)
  const now = Number.isSafeInteger(ctx.now) ? ctx.now : 0
  const lessons = [...normaliseLessons(store)]
  const at = lessons.findIndex((lesson) => lesson.key === key)
  if (at >= 0) {
    const prior = lessons[at]!
    // فاعلٌ واحد: النصّ المستقرّ لا يُبدَّل، والعدّاد وحده يتقدّم.
    lessons[at] = Object.freeze({ ...prior, seen: prior.seen + 1, lastSeen: Math.max(prior.lastSeen, now) })
    return Object.freeze({
      ok: true as const,
      store: Object.freeze({ version: GENERAL_STORE_VERSION, lessons: Object.freeze(lessons) }),
      key,
      added: false,
      changed: true,
      redactions,
      evicted: Object.freeze([]),
    })
  }
  lessons.push(Object.freeze({ key, cls, text, seen: 1, firstSeen: now, lastSeen: now }))
  const evicted: string[] = []
  while (lessons.length > GENERAL_STORE_CAP) {
    const victim = [...lessons].sort(evictionOrder)[0]!
    lessons.splice(lessons.indexOf(victim), 1)
    evicted.push(victim.key)
  }
  return Object.freeze({
    ok: true as const,
    store: Object.freeze({ version: GENERAL_STORE_VERSION, lessons: Object.freeze(lessons) }),
    key,
    added: !evicted.includes(key),
    changed: true,
    redactions,
    evicted: Object.freeze(evicted),
  })
}

export interface PromotionRun {
  readonly store: GeneralStore
  readonly promoted: readonly string[]
  readonly refusals: readonly string[]
  readonly redactions: number
  readonly changed: boolean
}

/** يرقّي دفعةً بالترتيب؛ رفضُ مرشّحٍ لا يُسقط الدفعة ويُسمّى بنصّه. */
export const promoteLessons = (store: GeneralStore, candidates: readonly PromotionCandidate[], ctx: PromotionContext): PromotionRun => {
  let current = normalise(store)
  const promoted: string[] = []
  const refusals: string[] = []
  let redactions = 0
  let changed = false
  for (const candidate of candidates ?? []) {
    const result = promoteLesson(current, candidate, ctx)
    if (!result.ok) { refusals.push(result.refused); continue }
    current = result.store
    redactions += result.redactions
    changed = changed || result.changed
    if (result.added) promoted.push(result.key)
  }
  return Object.freeze({ store: current, promoted: Object.freeze(promoted), refusals: Object.freeze(refusals), redactions, changed })
}

// ---------------------------------------------------------------------------
// المصدر المقنَّن — كتيّبٌ معتمَد بعد تأهيله
// ---------------------------------------------------------------------------

const PLAYBOOK_HINT = new Map(PLAYBOOKS.map((playbook) => [playbook.id, playbook.hint]))

/**
 * مرشّحو الترقية من الكتيّبات التي أطلقت في دورٍ **اكتمل**. التأهيل هنا ليس
 * ادّعاءً: الكتيّب أطلق على إيصالٍ حقيقيّ، ثمّ عبر الدورُ بوّابات القبول —
 * فالحلّ المقترَح مرَّ بجولةٍ كاملة لا بنيّة. والنصّ نصُّ المنتج لا نصُّ
 * المشروع: هذا وحده يُبقي المخزن العامّ خالياً من محتوى أيّ عميل.
 */
export const qualifiedPlaybookCandidates = (ids: readonly string[], completed: boolean): readonly PromotionCandidate[] => {
  if (!completed) return Object.freeze([])
  const seen = new Set<string>()
  const out: PromotionCandidate[] = []
  for (const id of ids ?? []) {
    const hint = PLAYBOOK_HINT.get(id)
    if (hint === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(Object.freeze({ cls: "playbook" as const, text: `«${id}»: ${hint}` }))
  }
  return Object.freeze(out)
}

// ---------------------------------------------------------------------------
// القرص — تحليلٌ ورسمٌ حتميّان (المضيف يقرأ ويكتب، والوحدة لا تعرف قرصاً)
// ---------------------------------------------------------------------------

const isLesson = (value: unknown): value is GeneralLesson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.key === "string" && row.key.length > 0
    && isGeneralClass(row.cls)
    && typeof row.text === "string" && row.text.length >= GENERAL_LESSON_MIN_CHARS && row.text.length <= GENERAL_LESSON_MAX_CHARS
    && Number.isSafeInteger(row.seen) && (row.seen as number) >= 1
    && Number.isSafeInteger(row.firstSeen) && Number.isSafeInteger(row.lastSeen)
}

const normaliseLessons = (store: GeneralStore | undefined): readonly GeneralLesson[] =>
  (store?.lessons ?? []).filter(isLesson)

const normalise = (store: GeneralStore | undefined): GeneralStore =>
  Object.freeze({ version: GENERAL_STORE_VERSION, lessons: Object.freeze([...normaliseLessons(store)]) })

/**
 * قراءةٌ **مميِّزة**: «غائب» ليس «غيرَ مقروء».
 *
 * `parseGeneralStore` تعيد الفارغ في الحالتين، وهو صحيحٌ للقراءة (لا نمرّر
 * بقيّةً لا نفهمها إلى مشروع عميلٍ آخر) وكارثيٌّ للكتابة: مخزنٌ كتبته نسخةٌ
 * أحدث يُقرأ فارغاً، ثمّ تُكتب فوقه نسخةٌ 1 فيها الدرسُ الجديد وحده — فيُمحى
 * متنُ الدروس العابرة للمشاريع كلُّه بلا حدثٍ ولا رفضٍ ولا نسخة. لذلك يميّز
 * هذا المُفصِح، ويرفض المنادي الكتابةَ حين لا يكون `ok`.
 */
export type GeneralStoreRead =
  | { readonly ok: true; readonly store: GeneralStore }
  | { readonly ok: false; readonly why: string }

export const inspectGeneralStore = (text: string): GeneralStoreRead => {
  if (typeof text !== "string" || text.trim().length === 0) return Object.freeze({ ok: true as const, store: EMPTY_GENERAL_STORE })
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return Object.freeze({ ok: false as const, why: "المخزن العامّ ليس JSON صالحاً" }) }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return Object.freeze({ ok: false as const, why: "المخزن العامّ ليس سجلّاً" })
  const record = parsed as Record<string, unknown>
  if (record.version !== GENERAL_STORE_VERSION) {
    return Object.freeze({ ok: false as const, why: `المخزن العامّ بنسخةٍ لا أعرفها (${String(record.version).slice(0, 20)} ≠ ${GENERAL_STORE_VERSION})` })
  }
  return Object.freeze({ ok: true as const, store: parseLessonRows(record.lessons) })
}

/**
 * فشلٌ مُغلق **للقراءة**: ملفٌّ مشوَّه أو نسخةٌ مجهولة أو سطرٌ لا يطابق الشكل
 * ⇒ يُسقَط. المخزن العامّ يُقرأ في مشروع عميلٍ آخر، فبقيّةٌ لا نفهمها لا
 * تُمرَّر «كما هي» على أمل أن تكون بريئة. ولا تُستعمل هذه قبل كتابة — انظر
 * `inspectGeneralStore`.
 */
export const parseGeneralStore = (text: string): GeneralStore => {
  const read = inspectGeneralStore(text)
  return read.ok ? read.store : EMPTY_GENERAL_STORE
}

const parseLessonRows = (value: unknown): GeneralStore => {
  const rows = Array.isArray(value) ? value : []
  const lessons: GeneralLesson[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isLesson(row)) continue
    if (seen.has(row.key)) continue
    seen.add(row.key)
    lessons.push(Object.freeze({ key: row.key, cls: row.cls, text: row.text, seen: row.seen, firstSeen: row.firstSeen, lastSeen: row.lastSeen }))
    if (lessons.length >= GENERAL_STORE_CAP) break
  }
  return Object.freeze({ version: GENERAL_STORE_VERSION, lessons: Object.freeze(lessons) })
}

/** رسمٌ حتميّ: ترتيبٌ بالمفتاح وحقولٌ بترتيبٍ ثابت — فرقٌ في الملفّ يعني تغيّراً. */
export const serialiseGeneralStore = (store: GeneralStore): string => {
  const lessons = [...normaliseLessons(store)].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const body = {
    version: GENERAL_STORE_VERSION,
    lessons: lessons.map((lesson) => ({ key: lesson.key, cls: lesson.cls, text: lesson.text, seen: lesson.seen, firstSeen: lesson.firstSeen, lastSeen: lesson.lastSeen })),
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// القراءة — معرفةٌ عامّة، لا قياسٌ عن هذا المشروع
// ---------------------------------------------------------------------------

/**
 * ترويسةُ النسب. لا تُبدَّل بلا سبب: النموذج يقرأ هذه الطبقة داخل مشروع
 * عميل، فلا بدّ أن يعرف أنها **ليست** قياساً عن مشروعه — وإلا نسب إلى
 * المشروع الحاليّ درساً لا إيصالَ له فيه.
 */
export const GENERAL_HEADING = "معرفة عامّة عابرة للمشاريع (دروسٌ مؤهَّلة في دليل التثبيت — ليست قياساً عن هذا المشروع، ولا تُنسب إليه):"

/** أقصرُ ما يبقى من سطرٍ مقصوص ليظلّ درساً لا شظيّة. */
export const GENERAL_BRIEF_MIN_LINE = 40
/** ولا سطرَ يبتلع الميزانيّة: درسٌ أطول يُقصّ بعلامةٍ ظاهرة ولا يُسقط ما بعده. */
export const GENERAL_BRIEF_LINE_MAX = 240

/**
 * موجزٌ رخيصٌ مسقوف — الأكثر ترقيةً أولاً، والترتيب حتميّ عند التساوي.
 *
 * **`continue` لا `break`**: السقفُ 500 حرفاً والدرسُ يبلغ 700، فدرسٌ واحدٌ
 * طويلٌ على رأس الترتيب كان يُسكِت الطبقةَ كلَّها — يعود «» فلا يفرّقها
 * المنادي عن «المفتاح مطفأ» ولا عن «المخزن فارغ»، بينما يرى المشغّل مخزناً
 * عامراً في `awareness`. فالآن: رأسُ الترتيب يُقصّ بعلامةٍ ظاهرة، وما بعده
 * لا يسقط بسقوطه — الأقصر يملأ ما بقي.
 */
export const generalAwarenessBrief = (store: GeneralStore | undefined, maxChars = 500): string => {
  const lessons = [...normaliseLessons(store)].sort((a, b) => (b.seen !== a.seen ? b.seen - a.seen : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (lessons.length === 0) return ""
  const lines: string[] = []
  let length = GENERAL_HEADING.length + 1
  for (const lesson of lessons) {
    const full = `- [${GENERAL_CLASS_LABEL[lesson.cls]}] ${lesson.text}`
    const room = Math.min(GENERAL_BRIEF_LINE_MAX, maxChars - length - 1)
    // ضاقت الميزانيّة عن سطرٍ ذي معنى ⇒ لا نقصّ إلى شظيّة، ونجرّب الأقصر بعده.
    if (room < GENERAL_BRIEF_MIN_LINE) continue
    const line = full.length <= room ? full : `${full.slice(0, room - 1)}…`
    lines.push(line)
    length += line.length + 1
  }
  if (lines.length === 0) return ""
  return `${GENERAL_HEADING}\n${lines.join("\n")}\n`
}
