/**
 * بحثُ ويبٍ بلا مفتاح — الفجوة #1 في جدول 2026-09-27 (ChatGPT وكوديكس وكلود يبحثون بلا مفتاحٍ يجلبه المستخدم).
 *
 * بلا مفتاحَي Google PSE كان `search` يفتح المتصفّح فقط ويطلب من النموذج أن يقرأ الصفحة بنفسه (open ثمّ page).
 * الآن: صفحةُ نتائج DuckDuckGo بصيغة HTML الخفيفة تُجلب **عبر محوّل النواة نفسِه** (`network_fetch`: فحصُ DNS/SSRF،
 * والتحويلاتُ مفحوصة، والأثرُ في الدفتر)، ويُستخرج منها حتميّاً العنوانُ والرابطُ الحقيقيّ والمقتطف — بلا نموذج.
 * الصورُ تحتاج PSE؛ وصفحةٌ بلا نتائج (حجبٌ أو تغيّرُ شكل) تُقال كما هي ويُعاد البديلُ المعروف.
 */
import type { GoogleSearchItem } from "./google-search"

export const KEYLESS_SOURCE = "DuckDuckGo"
/** الوجهةُ الوحيدة التي يُعلنها البحثُ لحارس الخروج — لحظةَ الاستدعاء الصريح لا عند الإقلاع (سابقةُ القوالب). */
export const KEYLESS_HOST = "html.duckduckgo.com"

export const keylessSearchUrl = (query: string, site?: string): string =>
  `https://${KEYLESS_HOST}/html/?q=${encodeURIComponent(site === undefined ? query : `${query} site:${site}`)}`

/** الرابطُ الحقيقيّ من رابط التحويل `//duckduckgo.com/l/?uddg=<مرمَّز>&rut=…`، أو `undefined` (إعلانٌ أو داخليّ). */
export function targetOf(href: string): string | undefined {
  const encoded = /[?&]uddg=([^&]+)/u.exec(href)?.[1]
  let url: string
  try { url = encoded === undefined ? href : decodeURIComponent(encoded) } catch { return undefined }
  if (!/^https?:\/\//iu.test(url)) return undefined
  try {
    const host = new URL(url).hostname
    if (/(?:^|\.)duckduckgo\.com$/iu.test(host)) return undefined
  } catch { return undefined }
  return url
}

/**
 * النتائجُ من النصّ المقروء (`[نصّ](رابط)`) الذي يعيده `fetch`: كلُّ نتيجةٍ روابطُ متتالية إلى الهدف نفسِه —
 * أوّلُها العنوان، وأطولُها بمسافاتٍ المقتطف، وما يشبه نطاقاً بلا مسافات هو الرابطُ المعروض.
 */
export function parseKeylessResults(readable: string, count: number): GoogleSearchItem[] {
  const byUrl = new Map<string, { title: string; snippet: string; displayUrl: string }>()
  for (const match of readable.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/gu)) {
    const text = match[1]!.trim()
    const url = targetOf(match[2]!)
    if (url === undefined || text.length === 0) continue
    const entry = byUrl.get(url)
    if (entry === undefined) {
      if (byUrl.size >= count) break
      byUrl.set(url, { title: text, snippet: "", displayUrl: "" })
      continue
    }
    if (!/\s/u.test(text) && /\./u.test(text)) entry.displayUrl ||= text
    else if (text !== entry.title && text.length > entry.snippet.length) entry.snippet = text
  }
  return [...byUrl].map(([url, e]) => ({ title: e.title.slice(0, 200), url, displayUrl: e.displayUrl || url.replace(/^https?:\/\//iu, "").slice(0, 120), snippet: e.snippet.slice(0, 400) }))
}

export const formatKeyless = (query: string, items: readonly GoogleSearchItem[]): string => {
  const head = `نتائج الويب عن «${query}» — ${KEYLESS_SOURCE} بلا مفتاح (plugins.keylessSearch)`
  if (items.length === 0) return `${head}\nلا نتائج.`
  return `${head}\n${items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ""}`).join("\n")}\nلقراءة صفحة: نفّذ: open <الرابط> ثمّ نفّذ: page`
}
