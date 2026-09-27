/**
 * صفحةُ HTML نصّاً مقروءاً — ما يصل النموذجَ من `fetch`.
 *
 * مقيس 2026-09-27: المحوّلُ كان يقصّ **أوّلَ 4000 محرفٍ من HTML الخام** — وهي في أغلب الصفحات `<head>` وأنماطٌ
 * وسكربتات. صفحةُ نتائج DuckDuckGo تبدأ أوّلُ نتيجةٍ فيها عند البايت 8186، فكان `fetch` يعيد **صفرَ نتائج**
 * ويبدو كأنّ الصفحة فارغة. الآن: السكربتُ والأنماطُ والرأسُ تُحذف (العنوانُ يبقى)، والروابطُ تبقى بصيغة
 * `[نصّ](رابط)` لأنّها ما يُتابَع، والكتلُ أسطر — ثمّ يُطبَّق السقف على ما يُقرأ لا على ما يُرسَم.
 * حتميّ بلا نموذج؛ وبصمةُ الدليل تبقى على البايتات الخام كما وصلت.
 */

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" }

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim()

/** نصٌّ مقروء من صفحة HTML: العنوان، ثمّ المحتوى بروابطه `[نصّ](رابط)`، بلا سكربت ولا أنماط ولا رأس. */
export function readableHtml(html: string): string {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? "")
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<head\b[\s\S]*?<\/head>/giu, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/giu, " ")
  body = body.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu, (_whole, dq: string | undefined, sq: string | undefined, inner: string) => {
    const href = decodeEntities((dq ?? sq ?? "").trim())
    const text = stripTags(inner)
    if (text.length === 0 || href.length === 0 || /^(?:javascript:|#)/iu.test(href)) return ` ${text} `
    return ` [${text.replace(/[[\]]/gu, "")}](${href.replace(/[()\s]/gu, (c) => encodeURIComponent(c))}) `
  })
  body = body
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|aside|blockquote|pre|form|dd|dt)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
  return title.length > 0 ? `${title}\n\n${text}` : text
}
