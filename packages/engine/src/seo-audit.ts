/**
 * 10-01 — تدقيقُ SEO وGEO وAEO وSXO بمعايير أكتوبر 2026.
 *
 * أداةُ `seo`: صفحةٌ تُقاس **كما يراها الزاحف** (HTML الخام قبل JavaScript — زواحفُ محرّكات الإجابة لا تشغّل JS غالباً) وكما يراها الإنسان
 * (الشجرةُ المرسومة)، ومعها ملفّاتُ الموقع (robots.txt، sitemap.xml، llms.txt) من الأصل نفسِه. أربعةُ أبعاد:
 * - SEO: العنوان والوصف والـcanonical وnoindex والعنوان الرئيسيّ وتسلسلُ العناوين وOpen Graph وhreflang وsitemap وrobots.
 * - GEO (محرّكاتُ التوليد — ChatGPT/Perplexity/Gemini/Claude): المحتوى في HTML الخام، زواحفُ البحث بالذكاء غيرُ محجوبة، llms.txt،
 *   بياناتٌ منظّمة للكيان (Organization/WebSite)، تاريخٌ ومؤلّفٌ للمقالات.
 * - AEO (محرّكاتُ الإجابة): عناوينُ بصيغة سؤال تليها إجابةٌ موجزة (40–60 كلمة مثاليّاً)، وFAQPage/QAPage/HowTo صالحة.
 * - SXO (تجربةُ البحث): viewport بلا منع تكبير، lang/dir، سكربتاتٌ حاجبةٌ للرسم، صورٌ بلا أبعاد (CLS)، LCP وCLS مقيسان في المتصفّح.
 * القياسُ داخل الصفحة (`SEO_MEASURE_SCRIPT`) والحكمُ هنا نقيّاً كي يُختبر بتوأمين لكلّ قاعدة.
 */

export type SeoDimension = "SEO" | "GEO" | "AEO" | "SXO"
export type SeoSeverity = "error" | "warn" | "info"

export interface SeoFinding {
  readonly dimension: SeoDimension
  readonly severity: SeoSeverity
  readonly check: string
  readonly detail: string
  readonly page: string
}

export interface SeoHeadFacts {
  readonly title: string
  readonly description: string
  readonly canonical: string
  readonly robotsMeta: string
  readonly lang: string
  readonly dir: string
  readonly viewport: string
  readonly ogTitle: string
  readonly ogDescription: string
  readonly ogImage: string
  readonly twitterCard: string
  readonly hreflang: readonly { readonly lang: string; readonly href: string }[]
  /** كلُّ أنواع JSON-LD (مع @graph)، وعددُ الكتل التي لم تُحلَّل JSON. */
  readonly jsonLdTypes: readonly string[]
  readonly jsonLdErrors: number
  /** أسئلةُ FAQPage/QAPage: لكلّ سؤالٍ هل له acceptedAnswer.text غير فارغ. */
  readonly faqItems: readonly { readonly question: string; readonly hasAnswer: boolean }[]
  readonly hasDatePublished: boolean
  readonly hasDateModified: boolean
  readonly hasAuthor: boolean
  readonly organizationFields: readonly string[]
  /** <script src> في <head> بلا async ولا defer ولا type=module. */
  readonly blockingScripts: number
  /** نصُّ <body> في HTML الخام (قبل JavaScript) بالأحرف. */
  readonly rawTextLength: number
}

export interface SeoRenderedFacts {
  readonly textLength: number
  readonly wordCount: number
  readonly h1Count: number
  readonly headings: readonly { readonly level: number; readonly text: string }[]
  readonly questionHeadings: readonly { readonly text: string; readonly answerWords: number }[]
  readonly imgNoAlt: number
  readonly imgNoDims: number
  readonly internalLinks: number
  /** مقيسان بـPerformanceObserver (buffered) — undefined حين لا قياس. */
  readonly lcpMs?: number
  readonly cls?: number
}

export interface SeoSiteFile {
  readonly status: number
  readonly text: string
}

export interface SeoPageMeasurement {
  readonly url: string
  readonly status: number
  readonly xRobotsTag: string
  readonly rawHtmlLength: number
  readonly head: SeoHeadFacts
  readonly rendered: SeoRenderedFacts
}

export interface SeoSiteMeasurement {
  readonly origin: string
  readonly robots: SeoSiteFile
  readonly sitemap: SeoSiteFile
  readonly llms: SeoSiteFile
}

/** زواحفُ تُنشئ إجاباتٍ وبحثاً بالذكاء (حجبُها = اختفاءٌ من الإجابات) — مقابلَ زواحف التدريب (حجبُها قرارٌ تجاريّ مشروع). */
export const AI_SEARCH_BOTS = Object.freeze(["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User", "Claude-SearchBot", "Claude-User", "Googlebot", "Bingbot"])
export const AI_TRAINING_BOTS = Object.freeze(["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Applebot-Extended", "Meta-ExternalAgent"])

/** هل يحجب robots.txt هذا الزاحف عن الجذر؟ مجموعةُ اسمه إن وُجدت، وإلّا مجموعةُ `*`. */
export function robotsBlocks(robotsText: string, bot: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = []
  let current: (typeof groups)[number] | undefined
  let lastWasAgent = false
  for (const rawLine of robotsText.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim()
    if (line === "") continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/u.exec(line)
    if (m === null) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (key === "user-agent") {
      if (!lastWasAgent || current === undefined) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false
      if (current !== undefined) current.rules.push({ allow: key === "allow", path: value })
    } else lastWasAgent = false
  }
  const own = groups.filter((g) => g.agents.includes(bot.toLowerCase()))
  const applicable = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"))
  const rules = applicable.flatMap((g) => g.rules)
  const rootDisallowed = rules.some((r) => !r.allow && r.path === "/")
  const rootAllowed = rules.some((r) => r.allow && (r.path === "/" || r.path === "/$"))
  return rootDisallowed && !rootAllowed
}

/** حكمُ صفحةٍ واحدة على الأبعاد الأربعة. */
export function analyzeSeoPage(m: SeoPageMeasurement): SeoFinding[] {
  const out: SeoFinding[] = []
  // المسارُ وحده على الخادم المحلّيّ؛ ومع النطاق لغيره — تقريرٌ يجمع موقعين لا يكتب «/» مرّتين (مقيس 10-01).
  const page = (() => { try { const u = new URL(m.url); return /^(?:127\.0\.0\.1|localhost|\[::1\])$/u.test(u.hostname) ? u.pathname || "/" : `${u.host}${u.pathname}` } catch { return m.url } })()
  const add = (dimension: SeoDimension, severity: SeoSeverity, check: string, detail: string): void => { out.push({ dimension, severity, check, detail, page }) }
  const h = m.head
  const r = m.rendered

  // ——— SEO ———
  if (m.status >= 400 || m.status === 0) add("SEO", "error", "status", `الصفحة ترد ${m.status || "لا ردّ"}`)
  if (h.title === "") add("SEO", "error", "title", "لا <title> في HTML الخام")
  else if (h.title.length > 60) add("SEO", "warn", "title-length", `العنوان ${h.title.length} حرفاً (> 60 يُقصّ في النتائج)`)
  else if (h.title.length < 10) add("SEO", "warn", "title-length", `العنوان ${h.title.length} أحرف — أقصرُ من أن يصف الصفحة`)
  if (h.description === "") add("SEO", "warn", "meta-description", "لا meta description — يكتب المحرّكُ مقتطفاً من عنده")
  else if (h.description.length > 160) add("SEO", "warn", "meta-description", `الوصف ${h.description.length} حرفاً (> 160 يُقصّ)`)
  else if (h.description.length < 50) add("SEO", "warn", "meta-description", `الوصف ${h.description.length} حرفاً (< 50 لا يكفي مقتطفاً)`)
  if (h.canonical === "") add("SEO", "warn", "canonical", "لا <link rel=canonical> — النسخُ المكرّرة (?utm، /index) تتقاسم الترتيب")
  else {
    try {
      const c = new URL(h.canonical, m.url)
      if (c.origin !== new URL(m.url).origin) add("SEO", "warn", "canonical", `canonical يشير إلى أصلٍ آخر: ${c.origin}`)
    } catch { add("SEO", "error", "canonical", `canonical غيرُ صالح: ${h.canonical.slice(0, 80)}`) }
  }
  if (/noindex/iu.test(h.robotsMeta) || /noindex/iu.test(m.xRobotsTag)) add("SEO", "error", "noindex", `الصفحة مستبعدةٌ من الفهرسة (${/noindex/iu.test(h.robotsMeta) ? "meta robots" : "X-Robots-Tag"})`)
  if (r.h1Count === 0) add("SEO", "warn", "h1", "لا <h1> في الصفحة")
  else if (r.h1Count > 1) add("SEO", "warn", "h1", `${r.h1Count} عناوين <h1> — واحدٌ يسمّي الصفحة`)
  for (let i = 1; i < r.headings.length; i += 1) {
    const prev = r.headings[i - 1]!.level
    const cur = r.headings[i]!.level
    if (cur > prev + 1) { add("SEO", "warn", "heading-skip", `قفزةٌ من h${prev} إلى h${cur} عند «${r.headings[i]!.text.slice(0, 50)}»`); break }
  }
  if (h.ogTitle === "" || h.ogImage === "") add("SEO", "warn", "open-graph", `Open Graph ناقص (${[h.ogTitle === "" ? "og:title" : "", h.ogDescription === "" ? "og:description" : "", h.ogImage === "" ? "og:image" : ""].filter(Boolean).join("، ")}) — المشاركةُ بلا بطاقة`)
  if (h.twitterCard === "") add("SEO", "info", "twitter-card", "لا twitter:card")
  if (h.hreflang.length > 0) {
    if (!h.hreflang.some((x) => x.lang.toLowerCase() === "x-default")) add("SEO", "warn", "hreflang", "hreflang بلا x-default")
    const self = h.hreflang.some((x) => { try { return new URL(x.href, m.url).href.replace(/\/$/u, "") === m.url.replace(/\/$/u, "") } catch { return false } })
    if (!self) add("SEO", "warn", "hreflang", "hreflang لا يشير إلى الصفحة نفسِها (المرجعُ الذاتيّ مطلوب)")
  }
  if (r.imgNoAlt > 0) add("SEO", "warn", "img-alt", `${r.imgNoAlt} صورة بلا alt`)
  if (r.internalLinks === 0) add("SEO", "warn", "internal-links", "لا روابط داخليّة — صفحةٌ يتيمة لا يعبر منها الزاحف")

  // ——— GEO ———
  if (m.rawHtmlLength > 0 && h.rawTextLength < 200 && r.textLength >= 500) add("GEO", "error", "server-rendered", `المحتوى يظهر بعد JavaScript فقط (HTML الخام ${h.rawTextLength} حرفاً مقابل ${r.textLength} مرسوماً) — زواحفُ الإجابة لا ترى الصفحة`)
  if (h.jsonLdTypes.length === 0) add("GEO", "warn", "structured-data", "لا JSON-LD — الكيانُ (من؟ ماذا؟) غيرُ مصرَّحٍ به للمحرّكات")
  if (h.jsonLdErrors > 0) add("GEO", "error", "structured-data", `${h.jsonLdErrors} كتلة JSON-LD لا تُحلَّل JSON`)
  const isArticle = h.jsonLdTypes.some((t) => /^(?:Article|NewsArticle|BlogPosting|TechArticle)$/u.test(t))
  if (isArticle && (!h.hasDateModified || !h.hasAuthor)) add("GEO", "warn", "article-provenance", `مقالٌ بلا ${[!h.hasDateModified ? "dateModified" : "", !h.hasAuthor ? "author" : ""].filter(Boolean).join(" ولا ")} — محرّكاتُ التوليد تفضّل المصدرَ المؤرَّخ المنسوب`)
  if (r.wordCount > 0 && r.wordCount < 150) add("GEO", "info", "thin-content", `${r.wordCount} كلمة — قليلٌ ليُقتبس منه`)

  // ——— AEO ———
  const faqSchema = h.jsonLdTypes.some((t) => t === "FAQPage" || t === "QAPage" || t === "HowTo")
  if (r.questionHeadings.length >= 2 && !faqSchema) add("AEO", "warn", "faq-schema", `${r.questionHeadings.length} عناوين بصيغة سؤال بلا FAQPage/QAPage — الإجابةُ لا تُلتقط مقتطفاً`)
  const unanswered = h.faqItems.filter((q) => !q.hasAnswer)
  if (unanswered.length > 0) add("AEO", "error", "faq-answer", `${unanswered.length} سؤالاً في FAQPage بلا acceptedAnswer.text — «${unanswered[0]!.question.slice(0, 50)}»`)
  const longAnswers = r.questionHeadings.filter((q) => q.answerWords > 120)
  if (longAnswers.length > 0) add("AEO", "warn", "answer-length", `${longAnswers.length} سؤالاً جوابُه الأوّل > 120 كلمة (الأمثل 40–60 تحت السؤال مباشرةً) — «${longAnswers[0]!.text.slice(0, 50)}»`)
  const noAnswer = r.questionHeadings.filter((q) => q.answerWords === 0)
  if (noAnswer.length > 0) add("AEO", "warn", "answer-missing", `${noAnswer.length} سؤالاً بلا فقرةِ إجابةٍ تليه — «${noAnswer[0]!.text.slice(0, 50)}»`)

  // ——— SXO ———
  if (h.viewport === "") add("SXO", "error", "viewport", "لا meta viewport — الجوّالُ يرى صفحةَ سطحِ مكتبٍ مصغّرة")
  else if (/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?(?:\D|$)/iu.test(h.viewport)) add("SXO", "warn", "viewport-zoom", "viewport يمنع التكبير (WCAG 1.4.4)")
  if (h.lang === "") add("SXO", "warn", "lang", "<html> بلا lang")
  else if (/^(?:ar|he|fa|ur)(?:-|$)/iu.test(h.lang) && h.dir.toLowerCase() !== "rtl") add("SXO", "error", "dir", `lang=${h.lang} بلا dir=rtl`)
  if (h.blockingScripts > 2) add("SXO", "warn", "render-blocking", `${h.blockingScripts} سكربتات في <head> بلا async/defer تحجب الرسم`)
  if (r.imgNoDims > 0) add("SXO", "warn", "img-dimensions", `${r.imgNoDims} صورة بلا width/height — إزاحةُ تخطيط (CLS)`)
  if (r.lcpMs !== undefined && r.lcpMs > 2500) add("SXO", r.lcpMs > 4000 ? "error" : "warn", "lcp", `LCP ${Math.round(r.lcpMs)}ms (الجيّد ≤ 2500)`)
  if (r.cls !== undefined && r.cls > 0.1) add("SXO", r.cls > 0.25 ? "error" : "warn", "cls", `CLS ${r.cls.toFixed(3)} (الجيّد ≤ 0.1)`)
  return out
}

/** حكمُ ملفّات الموقع: robots.txt وsitemap.xml وllms.txt. */
export function analyzeSeoSite(s: SeoSiteMeasurement): SeoFinding[] {
  const out: SeoFinding[] = []
  const add = (dimension: SeoDimension, severity: SeoSeverity, check: string, detail: string): void => { out.push({ dimension, severity, check, detail, page: "(الموقع)" }) }
  const robotsOk = s.robots.status === 200 && !/<html/iu.test(s.robots.text)
  if (!robotsOk) add("SEO", "warn", "robots.txt", `robots.txt ${s.robots.status === 200 ? "يردّ صفحةَ HTML لا ملفّاً" : `يرد ${s.robots.status}`}`)
  else {
    if (robotsBlocks(s.robots.text, "*") && robotsBlocks(s.robots.text, "Googlebot")) add("SEO", "error", "robots-disallow-all", "robots.txt يحجب الموقعَ كلَّه (Disallow: /)")
    if (!/^\s*sitemap\s*:/imu.test(s.robots.text)) add("SEO", "info", "robots-sitemap", "robots.txt لا يذكر Sitemap:")
    const searchBlocked = AI_SEARCH_BOTS.filter((b) => robotsBlocks(s.robots.text, b))
    if (searchBlocked.length > 0) add("GEO", "warn", "ai-search-bots", `محجوبٌ عن زواحف البحث بالذكاء: ${searchBlocked.join("، ")} — الموقعُ لا يظهر في إجاباتها`)
    const trainingBlocked = AI_TRAINING_BOTS.filter((b) => robotsBlocks(s.robots.text, b))
    if (trainingBlocked.length > 0) add("GEO", "info", "ai-training-bots", `محجوبٌ عن زواحف التدريب: ${trainingBlocked.join("، ")} (قرارٌ تجاريّ — لا يمسّ الظهور في البحث)`)
  }
  const urlCount = (s.sitemap.text.match(/<loc>/giu) ?? []).length
  if (s.sitemap.status !== 200 || !/<(?:urlset|sitemapindex)\b/iu.test(s.sitemap.text)) add("SEO", "warn", "sitemap", `sitemap.xml ${s.sitemap.status === 200 ? "ليس خريطةَ XML" : `يرد ${s.sitemap.status}`}`)
  else if (urlCount === 0) add("SEO", "warn", "sitemap", "sitemap.xml بلا <loc>")
  if (s.llms.status !== 200 || /<html/iu.test(s.llms.text) || s.llms.text.trim().length < 20) add("GEO", "warn", "llms.txt", "لا /llms.txt — خريطةٌ موجزة بالماركداون لمحرّكات التوليد (الموقعُ مَن، وأهمُّ صفحاته)")
  else if (!/^#\s+\S/mu.test(s.llms.text)) add("GEO", "info", "llms.txt", "llms.txt بلا عنوان H1 (# اسم الموقع) في أوّله")
  return out
}

export interface SeoReport {
  readonly passed: boolean
  readonly scores: Readonly<Record<SeoDimension, number>>
  readonly text: string
}

/** درجةٌ لكلّ بعد (100 − 15 لكلّ خطأ − 5 لكلّ تحذير، لا أقلّ من صفر) والحكمُ: لا أخطاء. */
export function renderSeoAudit(findings: readonly SeoFinding[], pages: number, origin: string): SeoReport {
  const dims: SeoDimension[] = ["SEO", "GEO", "AEO", "SXO"]
  const scores = Object.fromEntries(dims.map((d) => {
    const f = findings.filter((x) => x.dimension === d)
    return [d, Math.max(0, 100 - 15 * f.filter((x) => x.severity === "error").length - 5 * f.filter((x) => x.severity === "warn").length)]
  })) as Record<SeoDimension, number>
  const errors = findings.filter((f) => f.severity === "error")
  const warns = findings.filter((f) => f.severity === "warn")
  const passed = errors.length === 0
  const order = (f: SeoFinding): number => (f.severity === "error" ? 0 : f.severity === "warn" ? 1 : 2)
  const lines = [...findings].sort((a, b) => order(a) - order(b)).slice(0, 60)
    .map((f) => `${f.severity === "error" ? "✕" : f.severity === "warn" ? "△" : "·"} [${f.dimension}] ${f.page} · ${f.check}: ${f.detail}`)
  const head = `seo: ${passed ? "PASS" : "FAIL"} — ${origin} · ${pages} صفحة · ${errors.length} خطأ · ${warns.length} تحذير · ${dims.map((d) => `${d} ${scores[d]}`).join(" · ")}`
  return { passed, scores, text: [head, ...lines, ...(findings.length > 60 ? [`… و${findings.length - 60} أخرى`] : [])].join("\n") }
}

/**
 * القياسُ داخل الصفحة — يعيد JSON: `{page: SeoPageMeasurement, site?: SeoSiteMeasurement}`. HTML الخام يُجلب من الصفحة نفسِها
 * (`fetch(location.href)`) ويُحلَّل بـDOMParser — فلا يُرى ما أضافه JavaScript. يُمرَّر `__SITE__` = true لجلب ملفّات الموقع مرّةً واحدة.
 * (لا علامةَ ` ولا شرطةَ مائلة عكسيّة داخل النصّ — يُحقن عبر String.raw.)
 */
export const SEO_MEASURE_SCRIPT = String.raw`(async (withSite) => {
  const get = async (u) => { try { const r = await fetch(u, { credentials: "same-origin", redirect: "follow", cache: "no-store" }); return { status: r.status, text: (await r.text()).slice(0, 400000), xr: r.headers.get("x-robots-tag") || "" } } catch (e) { return { status: 0, text: "", xr: "" } } };
  const raw = await get(location.href);
  const doc = new DOMParser().parseFromString(raw.text, "text/html");
  const meta = (sel) => (doc.querySelector(sel)?.getAttribute("content") || "").trim();
  const types = []; let ldErrors = 0; const faq = []; let datePub = false, dateMod = false, author = false; const orgFields = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== "object") return;
    const t = node["@type"]; (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => types.push(String(x)));
    if (node.datePublished) datePub = true; if (node.dateModified) dateMod = true; if (node.author) author = true;
    const tl = Array.isArray(t) ? t.map(String) : [String(t || "")];
    if (tl.includes("Organization")) ["name", "url", "logo", "sameAs"].forEach((k) => { if (node[k]) orgFields.push(k) });
    if (tl.includes("Question")) { const a = node.acceptedAnswer; const txt = Array.isArray(a) ? a.map((x) => x && x.text).join(" ") : a && a.text; faq.push({ question: String(node.name || "").slice(0, 120), hasAnswer: typeof txt === "string" && txt.trim().length > 0 }) }
    if (node["@graph"]) visit(node["@graph"]);
    if (node.mainEntity) visit(node.mainEntity);
    for (const v of Object.values(node)) if (v && typeof v === "object" && v !== node["@graph"] && v !== node.mainEntity) visit(v);
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { visit(JSON.parse(s.textContent || "")) } catch (e) { ldErrors += 1 } });
  const blocking = [...doc.head?.querySelectorAll("script[src]") || []].filter((s) => !s.hasAttribute("async") && !s.hasAttribute("defer") && s.getAttribute("type") !== "module").length;
  doc.querySelectorAll("script,style,noscript,template").forEach((n) => n.remove());
  const rawText = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
  const head = {
    title: (doc.querySelector("title")?.textContent || "").trim(), description: meta('meta[name="description"]'),
    canonical: (doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "").trim(),
    robotsMeta: meta('meta[name="robots"]') + " " + meta('meta[name="googlebot"]'),
    lang: doc.documentElement.getAttribute("lang") || "", dir: doc.documentElement.getAttribute("dir") || "",
    viewport: meta('meta[name="viewport"]'), ogTitle: meta('meta[property="og:title"]'), ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'), twitterCard: meta('meta[name="twitter:card"]'),
    hreflang: [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => ({ lang: l.getAttribute("hreflang") || "", href: l.getAttribute("href") || "" })),
    jsonLdTypes: types, jsonLdErrors: ldErrors, faqItems: faq, hasDatePublished: datePub, hasDateModified: dateMod, hasAuthor: author,
    organizationFields: orgFields, blockingScripts: blocking, rawTextLength: rawText.length,
  };
  const main = document.body; const text = (main?.innerText || "").replace(/\s+/g, " ").trim();
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((e) => e.offsetParent !== null || e.tagName === "H1");
  const QUESTION = /[?؟]\s*$|^(how|what|why|when|where|which|who|can|does|do|is|are|should|كيف|ما|ماذا|لماذا|متى|أين|هل|من|كم)(\s|$)/i;
  const answerWords = (h) => { let n = h.nextElementSibling; let guard = 0; while (n && guard < 4) { const t = (n.innerText || "").trim(); if (/^H[1-6]$/.test(n.tagName)) return 0; if (t.length > 0) return t.split(/\s+/).length; n = n.nextElementSibling; guard += 1 } return 0 };
  const qs = hs.filter((h) => h.tagName !== "H1" && QUESTION.test((h.innerText || "").trim())).map((h) => ({ text: (h.innerText || "").trim().slice(0, 120), answerWords: answerWords(h) }));
  const imgs = [...document.images].filter((i) => i.offsetParent !== null);
  const links = [...document.querySelectorAll("a[href]")].filter((a) => { try { return new URL(a.getAttribute("href"), location.href).origin === location.origin } catch (e) { return false } }).length;
  const perf = await new Promise((done) => { let lcp, cls = 0; try { new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) lcp = e[e.length - 1].startTime }).observe({ type: "largest-contentful-paint", buffered: true }); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value }).observe({ type: "layout-shift", buffered: true }) } catch (e) {} setTimeout(() => done({ lcp, cls }), 400) });
  const rendered = {
    textLength: text.length, wordCount: text.split(" ").filter(Boolean).length, h1Count: document.querySelectorAll("h1").length,
    headings: hs.map((h) => ({ level: Number(h.tagName[1]), text: (h.innerText || "").trim().slice(0, 80) })), questionHeadings: qs,
    imgNoAlt: imgs.filter((i) => !i.hasAttribute("alt")).length, imgNoDims: imgs.filter((i) => (!i.getAttribute("width") || !i.getAttribute("height")) && !/^(absolute|fixed)$/.test(getComputedStyle(i).position) && getComputedStyle(i).aspectRatio === "auto").length,
    internalLinks: links, ...(perf.lcp !== undefined ? { lcpMs: perf.lcp } : {}), cls: perf.cls,
  };
  const page = { url: location.href, status: raw.status, xRobotsTag: raw.xr, rawHtmlLength: raw.text.length, head, rendered };
  if (!withSite) return JSON.stringify({ page });
  const [robots, sitemap, llms] = await Promise.all(["/robots.txt", "/sitemap.xml", "/llms.txt"].map((p) => get(location.origin + p)));
  const file = (f) => ({ status: f.status, text: f.text.slice(0, 60000) });
  return JSON.stringify({ page, site: { origin: location.origin, robots: file(robots), sitemap: file(sitemap), llms: file(llms) } });
})`
