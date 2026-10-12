/**
 * 10-12 — زاحفُ الموقع (crawl): (مشروعٌ مثل ClickUp).
 * المحرّكُ يفتح الصفحات واحدةً واحدة بالمتصفّح نفسِه الذي يعمل فيه الدور (كروم المستخدم عبر الإضافة، أو متصفّح عبدو كود)،
 * ويقرأ روابطها، ويحفظ نسخةَ كلِّ صفحة مرجعاً، ويكتب خريطةَ الموقع. هنا الجزءُ النقيّ: أيُّ رابطٍ يُزار، وrobots.txt، والخريطة.
 *
 * ما لا يُزار أبداً: أصلٌ آخر، ملفّات (pdf/zip/صور…)، وروابطُ تفعل شيئاً بمجرّد فتحها في حسابٍ مسجَّل (logout/delete/unsubscribe…) —
 * الزاحفُ يقرأ ولا يتصرّف. وrobots.txt يُحترم (Disallow وCrawl-delay لـ*)، والتأخيرُ بين الصفحات لا يقلّ عن ثانية.
 */

export interface Robots { readonly disallow: readonly string[]; readonly allow: readonly string[]; readonly delayMs: number }

export const NO_ROBOTS: Robots = Object.freeze({ disallow: [], allow: [], delayMs: 0 })

/** قواعدُ «User-agent: *» وحدها (لسنا زاحفاً مسمّى). مجموعاتٌ متتالية لـ* تُضمّ. */
export const parseRobots = (text: string): Robots => {
  const disallow: string[] = [], allow: string[] = []
  let delayMs = 0
  let inStar = false, sawRule = false
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim()
    if (line.length === 0) continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/u.exec(line)
    if (m === null) continue
    const key = m[1]!.toLowerCase(), value = m[2]!.trim()
    if (key === "user-agent") {
      if (sawRule) { inStar = false; sawRule = false }
      if (value === "*") inStar = true
      continue
    }
    sawRule = true
    if (!inStar) continue
    if (key === "disallow" && value.length > 0) disallow.push(value)
    else if (key === "allow" && value.length > 0) allow.push(value)
    else if (key === "crawl-delay") { const s = Number(value); if (Number.isFinite(s) && s > 0) delayMs = Math.min(30_000, Math.round(s * 1000)) }
  }
  return { disallow, allow, delayMs }
}

const ruleMatches = (rule: string, path: string): boolean => {
  const anchored = rule.endsWith("$")
  const body = anchored ? rule.slice(0, -1) : rule
  const pattern = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`, "u").test(path)
}

/** أطولُ قاعدةٍ مطابقة تحكم (Allow تغلب عند التساوي) — كما يفسّرها جوجل. */
export const robotsAllows = (robots: Robots, path: string): boolean => {
  let best = -1, allowed = true
  for (const rule of robots.disallow) if (ruleMatches(rule, path) && rule.length > best) { best = rule.length; allowed = false }
  for (const rule of robots.allow) if (ruleMatches(rule, path) && rule.length >= best) { best = rule.length; allowed = true }
  return allowed
}

const ACTION_LINK = /\/(?:log-?out|sign-?out|log-?off|delete|remove|destroy|unsubscribe|deactivate|revoke)(?:\/|$|[?#])|[?&](?:logout|signout|delete|remove|action=(?:delete|remove|logout))\b/iu
const FILE_LINK = /\.(?:pdf|zip|rar|7z|gz|tgz|tar|dmg|exe|msi|apk|mp4|mp3|wav|mov|avi|webm|png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf)$/iu
const TRACKING = /^(?:utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref|ref_src|_hs[a-z]+)$/iu

/** رابطٌ يُزار أو لا: الأصلُ نفسُه، بلا #، بلا معاملات تتبّع، لا ملفّ، لا فعل. يعيد الصيغةَ الموحَّدة أو undefined. */
export const crawlCandidate = (href: string, origin: string): string | undefined => {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  if (!/^https?:$/u.test(url.protocol) || url.origin !== origin) return undefined
  url.hash = ""
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  if (ACTION_LINK.test(url.pathname + url.search) || FILE_LINK.test(url.pathname)) return undefined
  return url.href
}

export interface CrawlArgs { readonly url: string; readonly max: number; readonly save: boolean; readonly shots: boolean }

/** `crawl <رابط> [max N] [nosave] [shots]` — الافتراض: 20 صفحة (السقف 60)، نسخةُ كلِّ صفحة تُحفظ، بلا لقطات. */
export const parseCrawlArgs = (rest: string): Readonly<{ ok: true } & CrawlArgs> | Readonly<{ ok: false; why: string }> => {
  const words = rest.trim().split(/\s+/u).filter((w) => w.length > 0)
  const url = words.find((w) => /^https?:\/\//iu.test(w))?.replace(/^["'«]+|["'»,]+$/gu, "")
  if (url === undefined) return { ok: false, why: "الصيغة: crawl <رابط http/https> [max N ≤ 60] [nosave] [shots] — يفتح صفحاتِ الموقع نفسِه ويحفظ نسخَها وخريطتَه" }
  try { new URL(url) } catch { return { ok: false, why: `رابطٌ غيرُ صالح: ${url.slice(0, 80)}` } }
  const maxText = /\bmax\s*[:=]?\s*(\d{1,3})\b/iu.exec(rest)?.[1] ?? words.find((w) => /^\d{1,3}$/u.test(w))
  const max = Math.min(60, Math.max(1, Number(maxText ?? 20) || 20))
  return { ok: true, url, max, save: !/\bno-?save\b/iu.test(rest), shots: /\bshots?\b/iu.test(rest) }
}

export interface CrawlPage {
  readonly url: string
  readonly title?: string
  readonly headings?: readonly string[]
  readonly links?: number
  readonly saved?: string
  readonly shot?: string
  readonly error?: string
}

/** خريطةُ الموقع ملفّاً يقرؤه النموذجُ بعد الزحف: الصفحةُ وعنوانُها وعناوينُها وأين حُفظت نسختُها. */
export const sitemapMarkdown = (start: string, browser: string, pages: readonly CrawlPage[], skipped: { robots: number; limit: number }): string => {
  const lines = [`# خريطة الموقع — ${start}`, "", `زُحفت ${pages.length} صفحة عبر ${browser} · تُخطّيت بـrobots.txt: ${skipped.robots} · بقيت فوق الحدّ: ${skipped.limit}`, ""]
  pages.forEach((page, i) => {
    let path = page.url
    try { const u = new URL(page.url); path = u.pathname + u.search } catch { /* الرابطُ كما هو */ }
    lines.push(`## ${i + 1}. ${path}${page.title ? ` — ${page.title}` : ""}`)
    if (page.error !== undefined) { lines.push(`- تعذّر: ${page.error}`, ""); return }
    for (const h of (page.headings ?? []).slice(0, 12)) lines.push(`- ${h}`)
    lines.push(`- روابط: ${page.links ?? 0}${page.saved ? ` · النسخة: ${page.saved}` : ""}${page.shot ? ` · اللقطة: ${page.shot}` : ""}`, "")
  })
  return lines.join("\n")
}
