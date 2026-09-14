/**
 * حَكَمُ «هذه الجملةُ قراءةٌ» — واحدٌ لكلّ المحرّكات، وقائمةُ المحظور تختلف.
 *
 * الازدواجُ أغلى صنفِ عيبٍ في هذا المستودع (تسعةَ عشرَ قدرةً في خمسةٍ وثلاثين
 * تنفيذاً بشهادة جرده). فحين لزم حكمٌ ثانٍ لبوستجرس لم تُنسخ الدالّة: خرج
 * الجزءُ المشترك إلى هنا، وبقي لكلّ محرّكٍ **قائمةُ محظوراته** — وهي وحدها ما
 * يختلف حقّاً: SQLite تخاف `ATTACH`، وبوستجرس تخاف `COPY … PROGRAM` و
 * `pg_read_file` و`dblink`.
 *
 * **وهذا ليس الحارس.** الحارسُ في SQLite اتّصالٌ للقراءة يفرضه المحرّك، وفي
 * بوستجرس جلسةٌ تُضبط `default_transaction_read_only` ودورٌ لا يملك الكتابة.
 * هذا يقول سبباً مفهوماً قبل أن يردّ المحرّكُ خطأً غامضاً، ويسدّ ما لا يسدّه
 * المحرّكُ من قراءاتٍ خارج القاعدة.
 */

/** الأفعالُ المسموحة — مغلقةٌ بالاسم لكلّ المحرّكات. */
export const READ_VERBS: readonly string[] = Object.freeze(["select", "with", "explain", "values", "table", "show"])

export interface SqlVerdict {
  readonly ok: boolean
  readonly why?: string
}

/** يجرّد التعليقات فيمنع «‎-- select‎» من إخفاء فعلٍ بعده. */
export const stripSqlComments = (raw: string): string =>
  raw.replace(/--[^\n]*/gu, " ").replace(/\/\*[\s\S]*?\*\//gu, " ").trim()

/**
 * يحكم على شكل الجملة: فعلٌ مسموح، وبلا كلمةٍ محظورة، وجملةٌ واحدة.
 *
 * `forbidden` كلماتٌ تُرفض **أينما وقعت** — وهي ما يختلف بين المحرّكات.
 */
export const judgeReadOnly = (raw: string, forbidden: readonly string[]): SqlVerdict => {
  const stripped = stripSqlComments(raw)
  if (stripped.length === 0) return { ok: false, why: "جملةٌ فارغة" }
  const lowered = stripped.toLowerCase()
  for (const word of forbidden) {
    if (lowered.includes(word)) return { ok: false, why: `«${word}» ممنوعة — الخادمُ مربوطٌ بقاعدةٍ واحدةٍ للقراءة` }
  }
  const verb = lowered.split(/[\s(]+/u, 1)[0] ?? ""
  if (!READ_VERBS.includes(verb)) {
    return { ok: false, why: `«${verb.slice(0, 24)}» ليست قراءة — المسموح: ${READ_VERBS.join("، ")}` }
  }
  // جملتان في نداءٍ واحد: الثانيةُ تفلت من حكم الأولى. والفواصلُ داخل النصوص
  // لا تُعدّ — وإلّا رُفض كلُّ استعلامٍ فيه «;» في سلسلة.
  const withoutStrings = stripped.replace(/'[^']*'/gu, "''").replace(/"[^"]*"/gu, '""')
  if (withoutStrings.replace(/;\s*$/u, "").includes(";")) return { ok: false, why: "جملةٌ واحدةٌ لكلّ نداء" }
  return { ok: true }
}

export * as ReadOnlySql from "./read-only-sql"
