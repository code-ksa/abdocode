/**
 * دفترُ الأحداث **سجلٌّ لا حارس** — فتلفُه يُعزل ويُقال، ولا يُسقط المحرّك.
 *
 * **مقيسٌ حيّاً على تثبيتٍ قائم**: أقلع المحرّكُ فسقط
 * بـ`SQLiteError: database disk image is malformed` عند أوّل قراءةٍ من دفتر serve،
 * فبقيت نافذةُ التطبيق مفتوحةً **بلا محرّكٍ خلفها**. ثمّ أُنقذ 105 أحداثٍ من 314،
 * فسقط ثانيةً بـ`serve_output_sequence_gap:3->8` لأنّ الفجوةَ ترفضها إعادةُ التشغيل.
 *
 * والحكمُ على هذين صائبٌ في موضعه: تسلسلُ المخرجات **لا يُخمَّن**، وصفٌّ تالفٌ لا يُقرأ.
 * لكنّ **موضعَ الحكم خطأ**: أن يمنع سجلُّ تاريخٍ تالفٌ المنتَجَ من العمل أصلاً هو أن
 * تُعاقَب الجلسةُ الحاضرةُ بذنب جلسةٍ ماضية. ومن ملك حذفَ الدفتر بيده ملك تشغيلَه —
 * فالحمايةُ لم تحمِ شيئاً، وكلّفت المنتَجَ كلَّه.
 *
 * فالقاعدة: **ما كان سجلّاً يُعزل ويُقال؛ وما كان حارساً يُغلق ويمنع.**
 *
 * والعزلُ لا يحذف أبداً: الدفترُ التالفُ يُنقل باسمٍ مؤرَّخ بجانبه، فيبقى لمن يريد
 * إنقاذَه — وقد أُنقذ منه فعلاً 105 أحداثٍ بقراءةٍ صفّاً صفّاً.
 *
 * الوحدةُ نقيّة: الخطأُ يصل مدخلاً، والمسارُ يُحسب، ولا قرصَ هنا.
 */

/** أشكالُ العطل التي تعني «الدفترُ لا يُقرأ» — لا «المنتَجُ معطوب». */
const UNREADABLE = [
  /SQLITE_CORRUPT/u,
  /database disk image is malformed/iu,
  /file is not a database/iu,
  /database is locked/iu,
  /serve_output_sequence_gap/u,
  /no such table/iu,
  /malformed database schema/iu,
]

/**
 * هل يعني هذا العطلُ أنّ الدفترَ لا يُقرأ؟
 *
 * والتمييزُ ضيّقٌ عمداً: عطلٌ غيرُ معروفٍ **يُرفع كما هو**. حارسٌ يبتلع كلَّ خطأٍ باسم
 * «العزل» يخفي عيباً حقيقيّاً في المحرّك ويجعل كلَّ إقلاعٍ يمحو تاريخاً بلا سبب.
 */
export function ledgerUnreadable(error: unknown): string | undefined {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const hit = UNREADABLE.find((rule) => rule.test(text))
  return hit === undefined ? undefined : text.slice(0, 200)
}

/** اسمُ العزل: بجانب الدفتر، مؤرَّخٌ بالثانية، ولا يدهس عزلاً سابقاً. */
export function quarantineName(database: string, at: Date): string {
  const stamp = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
    "-",
    String(at.getHours()).padStart(2, "0"),
    String(at.getMinutes()).padStart(2, "0"),
    String(at.getSeconds()).padStart(2, "0"),
  ].join("")
  return `${database}.unreadable-${stamp}`
}

/** الملفّاتُ المصاحبةُ التي تُعزل معه — وإلّا أعاد WAL التلفَ إلى دفترٍ جديد. */
export function companionFiles(database: string): string[] {
  return [`${database}-wal`, `${database}-shm`, `${database}-journal`]
}

/** سطرُ الإيصال — يُقال في الإقلاع، ولا صمتَ عن تاريخٍ عُزل. */
export function quarantineNotice(moved: string, why: string): string {
  return `⚠ دفترُ الأحداث لم يُقرأ (${why}) — عُزل باسم «${moved}» وبدأ المحرّكُ دفتراً جديداً. تاريخُ الأدوار السابق **لم يُحذف**: هو في الملفّ المعزول. والإعداداتُ والخزنةُ والجلساتُ لم تُمسّ.`
}
