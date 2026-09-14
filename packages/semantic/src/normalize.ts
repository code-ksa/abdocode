/**
 * التطبيعُ العربيّ — الطبقةُ صفر من المحرّك الدلاليّ.
 *
 * أمر المالك (2026-09-06): «يفهم اللهجات العربية باحترافية عالية… مثلما أنت تفعل».
 * والفهمُ يبدأ من أن الكلمةَ الواحدة تُكتب بعشر صور: بتشكيلٍ وبدونه، بهمزةٍ وبدونها،
 * بتاءٍ مربوطة أو هاء، بألفٍ مقصورة أو ياء، بأرقامٍ هندية أو عربية، وبأداةٍ ملتصقة
 * («للفواتير» تحوي «فواتير» ولا تحوي «الفواتير»، و«هالمجلد» الخليجية تحوي «مجلد»).
 * فيُطوى الرسمُ **على الجانبين** قبل أيّ مقارنة — درسٌ مدفوعُ الثمن: مطابقةٌ بلا تطبيعٍ
 * ثغرة، وحارسٌ بلا قياسِ الاتجاه المعاكس يحجب اللغةَ نفسها.
 *
 * حدودُ الكلمة هنا **حروفٌ لا `\b`**: `\b` في JavaScript لا يعرف حافّةَ الكلمة
 * العربية أبداً (مقيس: ٤٠/٧٨ تصنيفاً خاطئاً قبل الإصلاح في مشروعٍ شقيق).
 *
 * الوحدةُ نقيّة: لا شبكة ولا قرص ولا نموذج. تعمل في ملّي ثوانٍ مع كلّ إيداع.
 */

/** تشكيلٌ، ألفٌ خنجرية، تطويل، ومحارفُ العرض الصفري — تُنزع كلُّها. */
const STRIP = /[\u064B-\u0652\u0670\u0640\u200B-\u200F\uFEFF]/gu

const INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/gu
const indicToAscii = (ch: string): string => {
  const code = ch.codePointAt(0) ?? 0
  const base = code >= 0x06f0 ? 0x06f0 : 0x0660
  return String(code - base)
}

/**
 * طيُّ الرسم: حروفٌ صغيرة، بلا تشكيل، الهمزاتُ ألفاً، التاءُ المربوطة هاءً، الألفُ
 * المقصورة ياءً، الأرقامُ الهندية لاتينية، والفراغُ مضغوطاً.
 * «أَنْشِئْ مُجَلَّدًا» ⇦ «انشي مجلدا» — لا يهمّ الشكلُ، يهمّ ما يُقصد.
 */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(STRIP, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ة/gu, "ه")
    .replace(/ى/gu, "ي")
    .replace(/ؤ/gu, "و")
    .replace(/ئ/gu, "ي")
    .replace(INDIC_DIGITS, indicToAscii)
    .replace(/\s+/gu, " ")
    .trim()
}

/** كلماتٌ: حروفٌ وأرقامٌ فقط — للفهم لا للمعرّفات. */
export function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)
}

/** رموزٌ خامّ: مقسومةٌ على الفراغ فقط — تحفظ المعرّفات كما هي (`app/page.tsx`، `.env`). */
export function rawTokens(text: string): string[] {
  return text.trim().split(/\s+/u).filter((t) => t.length > 0)
}

const PREFIXES = ["وبال", "فبال", "وهال", "بهال", "ولل", "فلل", "وال", "فال", "بال", "كال", "هال", "لل", "ال", "و", "ف", "ب", "ل", "ك"]
const SUFFIXES = ["هما", "كما", "ها", "هم", "هن", "كم", "كن", "نا", "ني", "ه", "ك", "ي"]
const MIN_STEM = 3

/**
 * الجذعُ بلا أداة: العربيةُ تُلصق الأدواتِ في أوّل الكلمة وآخرها — «وللفواتير» هي
 * «فواتير» بثلاث أدوات، و«هالمجلد» هي «مجلد» بأداة الإشارة الخليجية. يُعاد الرمزُ
 * نفسُه أولاً ثم صورُه المجرّدة، **بتحفّظ**: لا يُنزع حرفٌ إن كان ما يبقى أقصرَ من
 * ثلاثة، ولا يُمسّ حرفا المضارعة (هـ/س) لأنهما من الفعل لا من الأداة («هات» ليست «ات»).
 * البادئاتُ تُنزع بمرورين (أداةٌ فوق أداة)، ثم اللواحق على كلّ ما نتج.
 */
export function stems(token: string): string[] {
  const out: string[] = [token]
  const seen = new Set(out)
  const push = (s: string) => { if (s.length >= MIN_STEM && !seen.has(s)) { seen.add(s); out.push(s) } }
  let frontier = [token]
  for (let pass = 0; pass < 2; pass++) {
    const next: string[] = []
    for (const base of frontier) for (const p of PREFIXES) if (base.startsWith(p)) { const rest = base.slice(p.length); if (rest.length >= MIN_STEM) { push(rest); next.push(rest) } }
    frontier = next
    if (frontier.length === 0) break
  }
  for (const base of [...out]) for (const s of SUFFIXES) if (base.endsWith(s)) push(base.slice(0, base.length - s.length))
  return out
}

/** حدُّ الكلمة العربية/اللاتينية: ما ليس حرفاً ولا رقماً — بديلُ `\b` الذي لا يعمل. */
export const NOT_LETTER_BEFORE = "(?<![\\p{L}\\p{N}])"
export const NOT_LETTER_AFTER = "(?![\\p{L}\\p{N}])"

/** تعبيرٌ نمطيّ لكلمةٍ كاملة (أو عبارةٍ) من صورها — تُطوى الصورُ هنا فلا يُشترط أن تُكتب مطويّة. */
export function wordRe(alternatives: readonly string[], flags = "u"): RegExp {
  const body = [...new Set(alternatives.map((a) => fold(a)))]
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"))
    .join("|")
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${body})${NOT_LETTER_AFTER}`, flags)
}
