/**
 * 🔴 **مرشّحو الذاكرة كانوا يُختارون بالحداثة لا بالصلة.**
 *
 * المرتّبُ الدلاليُّ يأخذ آخرَ 128 حقيقةً ثمّ يسأل النموذجَ أيَّها يناسب. وقِيس على
 * متنِ ذاكرتنا الحقيقيّ (325 ملفّاً): **61% منه خارج النافذة** — لا يراه المرتّبُ
 * أبداً مهما كان السؤال. فالذاكرةُ القديمةُ الدقيقةُ تُهزم بملاحظةٍ كُتبت اليوم.
 *
 * فيُقدَّم **ترشيحٌ حتميٌّ بالصلة** (BM25) قبل النموذج: القاعدةُ عندنا أنّ الكودَ
 * الحتميَّ يسبق النموذج، ولا يُصعَد إلا بفشلٍ مثبت. والكلفةُ صفرُ توكن.
 *
 * ولماذا BM25 مكتوباً هنا لا SQLite/FTS5: الخوارزميّةُ نفسُها على بضع مئاتٍ من
 * النصوص القصيرة، بلا تبعيّةٍ أصليّةٍ ولا ملفٍّ على القرص ولا فهرسٍ يُبنى ويُهدَم
 * في كلّ دور. (قِيس: FTS5 على المتن نفسِه أعطى 51.7% استرجاع@5؛ وهذا يطابقه.)
 *
 * والتطبيعُ العربيُّ شرطٌ لا زينة: بلا نزع التشكيل والتطويل وتوحيد الهمزات
 * تفترق «الحارسُ» عن «الحارس» فيسقط الاسترجاع.
 */

/** تطبيعٌ قبل التقطيع — العربيّةُ تُطابَق بجذرِ شكلها لا بزخرفته. */
export function normalizeForRecall(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[ً-ْٰـ]/gu, "")        // تشكيل وتطويل
    .replace(/[آأإٱ]/gu, "ا")   // همزات الألف
    .replace(/ى/gu, "ي")                        // ألف مقصورة
    .replace(/ة/gu, "ه")                        // تاء مربوطة
    .replace(/[​-‏‪-‮]/gu, "")        // صفرُ العرض
    .toLowerCase()
}

/**
 * كلماتُ وقفٍ في اللغتين — لا تحمل صلةً فتضخّم الضجيج.
 *
 * 🔴 **وتُطبَّع هي نفسُها**، وإلّا كانت حارساً على الجانب الخطأ من المُطبِّع: التطبيعُ
 * يحوّل «على» إلى «علي» و«إلى» إلى «الي»، فلا تطابق القائمةَ المكتوبةَ بالشكل الأصليّ
 * وتمرّ كلمةُ وقفٍ على أنّها دلاليّة. قِيس: `tokenize("من في على الحارس")` أعاد
 * «علي» معها. وهو الدرسُ نفسُه: **حارسٌ بلا تطبيعٍ ثغرة** — والقائمةُ حارس.
 */
const STOP = new Set(
  "من في على إلى عن مع هذا هذه التي الذي لا ما أن إن كان قد بعد قبل كل بين هو هي و أو ثم the a an of to in is it and or for on with that this"
    .split(/\s+/u)
    .map((word) => normalizeForRecall(word)),
)

export function tokenize(text: string): string[] {
  return normalizeForRecall(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w))
}

export interface RecallCandidate { readonly id: number; readonly text: string }

const K1 = 1.2
const B = 0.75

/**
 * يعيد معرّفاتِ المرشّحين مرتّبةً بالصلة (BM25)، حتى `limit`.
 * استعلامٌ فارغٌ أو بلا تطابقٍ يعيد `[]` — فالمُنادي يقرّر التراجعَ إلى الحداثة،
 * ولا تخترع هذه الوحدةُ ترتيباً لا تملك سبباً له. **الغياب رفضٌ لا إذن.**
 */
export function rankByRelevance(candidates: readonly RecallCandidate[], query: string, limit: number): number[] {
  const terms = tokenize(query)
  if (terms.length === 0 || candidates.length === 0 || limit <= 0) return []

  const docs = candidates.map((c) => tokenize(c.text))
  const lengths = docs.map((d) => d.length)
  const avg = lengths.reduce((a, b) => a + b, 0) / (docs.length || 1)
  if (avg === 0) return []

  const df = new Map<string, number>()
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)

  const scored: { id: number; score: number }[] = []
  for (let i = 0; i < docs.length; i += 1) {
    const counts = new Map<string, number>()
    for (const term of docs[i]!) counts.set(term, (counts.get(term) ?? 0) + 1)
    let score = 0
    for (const term of new Set(terms)) {
      const f = counts.get(term)
      if (f === undefined) continue
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * lengths[i]!) / avg)))
    }
    if (score > 0) scored.push({ id: candidates[i]!.id, score })
  }
  // ترتيبٌ ثابت: الأعلى صلةً، وعند التساوي الأحدثُ معرّفاً — كي لا يتبدّل الجوابُ بين دورين.
  scored.sort((a, b) => (b.score - a.score) || (b.id - a.id))
  return scored.slice(0, limit).map((s) => s.id)
}
