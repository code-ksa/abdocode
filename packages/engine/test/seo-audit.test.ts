/**
 * 10-01 — أداةُ seo (SEO/GEO/AEO/SXO). لكلّ قاعدةٍ توأمان: قياسٌ يجب أن يُمسك، وقياسٌ يجب أن يمرّ.
 */
import { describe, expect, test } from "bun:test"
import { SEO_MEASURE_SCRIPT, analyzeSeoPage, analyzeSeoSite, renderSeoAudit, robotsBlocks, type SeoPageMeasurement, type SeoSiteMeasurement } from "../src/seo-audit"

const clean: SeoPageMeasurement = {
  url: "https://example.sa/models", status: 200, xRobotsTag: "", rawHtmlLength: 40000,
  head: {
    title: "نماذج الذكاء الاصطناعي — متجر النماذج", description: "قارن أكثر من 300 نموذج ذكاء اصطناعي بالسعر والسرعة وطول السياق، وجرّبها من واجهة واحدة.",
    canonical: "https://example.sa/models", robotsMeta: " ", lang: "ar", dir: "rtl", viewport: "width=device-width, initial-scale=1",
    ogTitle: "نماذج", ogDescription: "قارن النماذج", ogImage: "https://example.sa/og.png", twitterCard: "summary_large_image",
    hreflang: [], jsonLdTypes: ["Organization", "WebSite"], jsonLdErrors: 0, faqItems: [], hasDatePublished: false, hasDateModified: false, hasAuthor: false,
    organizationFields: ["name", "url", "logo"], blockingScripts: 0, rawTextLength: 3200,
  },
  rendered: { textLength: 3400, wordCount: 520, h1Count: 1, headings: [{ level: 1, text: "النماذج" }, { level: 2, text: "الأكثر استخداماً" }], questionHeadings: [], imgNoAlt: 0, imgNoDims: 0, internalLinks: 30, lcpMs: 1200, cls: 0.02 },
}
const page = (p: { head?: Partial<SeoPageMeasurement["head"]>; rendered?: Partial<SeoPageMeasurement["rendered"]> } & Partial<Omit<SeoPageMeasurement, "head" | "rendered">>): SeoPageMeasurement =>
  ({ ...clean, ...p, head: { ...clean.head, ...p.head }, rendered: { ...clean.rendered, ...p.rendered } })
const checks = (m: SeoPageMeasurement) => analyzeSeoPage(m).filter((f) => f.severity !== "info").map((f) => `${f.dimension}:${f.severity}:${f.check}`)

describe("seo page — the clean page passes every rule", () => {
  test("no errors and no warnings on a complete page", () => {
    expect(checks(clean)).toEqual([])
  })
})

describe("SEO", () => {
  test("missing title is an error; a 70-char title is a warning", () => {
    expect(checks(page({ head: { title: "" } }))).toContain("SEO:error:title")
    expect(checks(page({ head: { title: "x".repeat(70) } }))).toContain("SEO:warn:title-length")
  })
  test("description missing, too long, too short", () => {
    expect(checks(page({ head: { description: "" } }))).toContain("SEO:warn:meta-description")
    expect(checks(page({ head: { description: "x".repeat(200) } }))).toContain("SEO:warn:meta-description")
    expect(checks(page({ head: { description: "قصير" } }))).toContain("SEO:warn:meta-description")
  })
  test("canonical: missing, cross-origin, relative same-origin passes", () => {
    expect(checks(page({ head: { canonical: "" } }))).toContain("SEO:warn:canonical")
    expect(checks(page({ head: { canonical: "https://other.com/models" } }))).toContain("SEO:warn:canonical")
    expect(checks(page({ head: { canonical: "/models" } }))).not.toContain("SEO:warn:canonical")
  })
  test("noindex in meta or in X-Robots-Tag is an error", () => {
    expect(checks(page({ head: { robotsMeta: "noindex, follow" } }))).toContain("SEO:error:noindex")
    expect(checks(page({ xRobotsTag: "noindex" }))).toContain("SEO:error:noindex")
    expect(checks(page({ head: { robotsMeta: "index, follow" } }))).not.toContain("SEO:error:noindex")
  })
  test("h1 count and heading skips", () => {
    expect(checks(page({ rendered: { h1Count: 0 } }))).toContain("SEO:warn:h1")
    expect(checks(page({ rendered: { h1Count: 3 } }))).toContain("SEO:warn:h1")
    expect(checks(page({ rendered: { headings: [{ level: 1, text: "a" }, { level: 3, text: "b" }] } }))).toContain("SEO:warn:heading-skip")
    expect(checks(page({ rendered: { headings: [{ level: 1, text: "a" }, { level: 2, text: "b" }, { level: 3, text: "c" }, { level: 2, text: "d" }] } }))).not.toContain("SEO:warn:heading-skip")
  })
  test("open graph and hreflang", () => {
    expect(checks(page({ head: { ogImage: "" } }))).toContain("SEO:warn:open-graph")
    const hreflang = [{ lang: "ar", href: "https://example.sa/models" }, { lang: "en", href: "https://example.sa/en/models" }]
    expect(checks(page({ head: { hreflang } }))).toContain("SEO:warn:hreflang")
    expect(checks(page({ head: { hreflang: [...hreflang, { lang: "x-default", href: "https://example.sa/models" }] } }))).not.toContain("SEO:warn:hreflang")
    expect(checks(page({ head: { hreflang: [{ lang: "en", href: "https://example.sa/en/models" }, { lang: "x-default", href: "https://example.sa/" }] } }))).toContain("SEO:warn:hreflang")
  })
  test("images without alt and orphan pages", () => {
    expect(checks(page({ rendered: { imgNoAlt: 2 } }))).toContain("SEO:warn:img-alt")
    expect(checks(page({ rendered: { internalLinks: 0 } }))).toContain("SEO:warn:internal-links")
  })
  test("a page that answers 404 is an error", () => {
    expect(checks(page({ status: 404 }))).toContain("SEO:error:status")
  })
})

describe("GEO", () => {
  test("content that exists only after JavaScript is invisible to answer engines", () => {
    expect(checks(page({ head: { rawTextLength: 40 }, rendered: { textLength: 3000 } }))).toContain("GEO:error:server-rendered")
    expect(checks(page({ head: { rawTextLength: 40 }, rendered: { textLength: 100 } }))).not.toContain("GEO:error:server-rendered")
  })
  test("no JSON-LD is a warning; a block that does not parse is an error", () => {
    expect(checks(page({ head: { jsonLdTypes: [] } }))).toContain("GEO:warn:structured-data")
    expect(checks(page({ head: { jsonLdErrors: 1 } }))).toContain("GEO:error:structured-data")
  })
  test("an article needs dateModified and an author", () => {
    expect(checks(page({ head: { jsonLdTypes: ["BlogPosting"] } }))).toContain("GEO:warn:article-provenance")
    expect(checks(page({ head: { jsonLdTypes: ["BlogPosting"], hasDateModified: true, hasAuthor: true } }))).not.toContain("GEO:warn:article-provenance")
  })
})

describe("AEO", () => {
  const qs = [{ text: "ما هو سوق النماذج؟", answerWords: 45 }, { text: "How do I get an API key?", answerWords: 50 }]
  test("question headings without FAQ schema", () => {
    expect(checks(page({ rendered: { questionHeadings: qs } }))).toContain("AEO:warn:faq-schema")
    expect(checks(page({ head: { jsonLdTypes: ["FAQPage"] }, rendered: { questionHeadings: qs } }))).not.toContain("AEO:warn:faq-schema")
  })
  test("FAQ questions need an accepted answer", () => {
    expect(checks(page({ head: { jsonLdTypes: ["FAQPage"], faqItems: [{ question: "q", hasAnswer: false }] } }))).toContain("AEO:error:faq-answer")
    expect(checks(page({ head: { jsonLdTypes: ["FAQPage"], faqItems: [{ question: "q", hasAnswer: true }] } }))).not.toContain("AEO:error:faq-answer")
  })
  test("an answer longer than 120 words, or none, under a question heading", () => {
    expect(checks(page({ head: { jsonLdTypes: ["FAQPage"] }, rendered: { questionHeadings: [{ text: "لماذا؟", answerWords: 300 }] } }))).toContain("AEO:warn:answer-length")
    expect(checks(page({ head: { jsonLdTypes: ["FAQPage"] }, rendered: { questionHeadings: [{ text: "لماذا؟", answerWords: 0 }] } }))).toContain("AEO:warn:answer-missing")
  })
})

describe("SXO", () => {
  test("viewport missing or blocking zoom", () => {
    expect(checks(page({ head: { viewport: "" } }))).toContain("SXO:error:viewport")
    expect(checks(page({ head: { viewport: "width=device-width, initial-scale=1, maximum-scale=1" } }))).toContain("SXO:warn:viewport-zoom")
    expect(checks(page({ head: { viewport: "width=device-width, initial-scale=1, maximum-scale=5" } }))).not.toContain("SXO:warn:viewport-zoom")
  })
  test("Arabic without dir=rtl is an error; English without dir passes", () => {
    expect(checks(page({ head: { dir: "" } }))).toContain("SXO:error:dir")
    expect(checks(page({ head: { lang: "en", dir: "" } }))).not.toContain("SXO:error:dir")
    expect(checks(page({ head: { lang: "" } }))).toContain("SXO:warn:lang")
  })
  test("render-blocking scripts, images without dimensions, LCP and CLS", () => {
    expect(checks(page({ head: { blockingScripts: 4 } }))).toContain("SXO:warn:render-blocking")
    expect(checks(page({ rendered: { imgNoDims: 3 } }))).toContain("SXO:warn:img-dimensions")
    expect(checks(page({ rendered: { lcpMs: 3000 } }))).toContain("SXO:warn:lcp")
    expect(checks(page({ rendered: { lcpMs: 5000 } }))).toContain("SXO:error:lcp")
    expect(checks(page({ rendered: { cls: 0.3 } }))).toContain("SXO:error:cls")
    expect(checks(page({ rendered: { lcpMs: undefined, cls: undefined } }))).toEqual([])
  })
})

describe("site files", () => {
  const good: SeoSiteMeasurement = {
    origin: "https://example.sa",
    robots: { status: 200, text: "User-agent: *\nAllow: /\nSitemap: https://example.sa/sitemap.xml\n" },
    sitemap: { status: 200, text: '<?xml version="1.0"?><urlset><url><loc>https://example.sa/</loc></url></urlset>' },
    llms: { status: 200, text: "# متجر النماذج\n\n> سوقُ نماذج الذكاء الاصطناعي.\n\n- [النماذج](https://example.sa/models)\n" },
  }
  const siteChecks = (s: Partial<SeoSiteMeasurement>) => analyzeSeoSite({ ...good, ...s }).filter((f) => f.severity !== "info").map((f) => `${f.dimension}:${f.severity}:${f.check}`)
  test("a complete site has no gaps", () => { expect(siteChecks({})).toEqual([]) })
  test("a Next.js 404 page served as robots.txt / llms.txt is not the file", () => {
    expect(siteChecks({ robots: { status: 200, text: "<!DOCTYPE html><html><body>404</body></html>" } })).toContain("SEO:warn:robots.txt")
    expect(siteChecks({ llms: { status: 404, text: "" } })).toContain("GEO:warn:llms.txt")
    expect(siteChecks({ sitemap: { status: 404, text: "" } })).toContain("SEO:warn:sitemap")
  })
  test("Disallow: / for everyone is an error; blocking AI search bots is a GEO warning; training bots are info only", () => {
    expect(siteChecks({ robots: { status: 200, text: "User-agent: *\nDisallow: /\n" } })).toContain("SEO:error:robots-disallow-all")
    expect(siteChecks({ robots: { status: 200, text: "User-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: x\n" } })).toEqual(["GEO:warn:ai-search-bots"])
    const training = analyzeSeoSite({ ...good, robots: { status: 200, text: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: x\n" } })
    expect(training.filter((f) => f.severity !== "info")).toEqual([])
    expect(training.map((f) => f.check)).toContain("ai-training-bots")
  })
})

describe("robots.txt parser", () => {
  test("own group beats *, consecutive user-agent lines share a group, comments are ignored", () => {
    const txt = "# hi\nUser-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nUser-agent: Bingbot\nAllow: /\n"
    expect(robotsBlocks(txt, "Googlebot")).toBe(false)
    expect(robotsBlocks(txt, "bingbot")).toBe(false)
    expect(robotsBlocks(txt, "GPTBot")).toBe(true)
    expect(robotsBlocks("User-agent: *\nDisallow: /admin\n", "GPTBot")).toBe(false)
    expect(robotsBlocks("", "GPTBot")).toBe(false)
    // الأوّلُ في سطرَي user-agent المتتاليين يقع تحت قاعدة المجموعة نفسِها — لا مجموعةَ فارغةً تُعتقه.
    expect(robotsBlocks("User-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "OAI-SearchBot")).toBe(true)
  })
})

describe("page label", () => {
  test("the local server shows the path; an external site shows host and path (two origins in one report stay apart)", () => {
    expect(analyzeSeoPage(page({ url: "http://127.0.0.1:3400/models", head: { title: "" } }))[0]!.page).toBe("/models")
    expect(analyzeSeoPage(page({ url: "https://build.nvidia.com/", head: { title: "" } }))[0]!.page).toBe("build.nvidia.com/")
  })
})

describe("report", () => {
  test("PASS needs zero errors; scores drop 15 per error and 5 per warning", () => {
    const f = analyzeSeoPage(page({ head: { title: "", viewport: "" }, rendered: { imgNoAlt: 1 } }))
    const r = renderSeoAudit(f, 1, "https://example.sa")
    expect(r.passed).toBe(false)
    expect(r.scores.SEO).toBe(100 - 15 - 5)
    expect(r.scores.SXO).toBe(85)
    expect(r.scores.GEO).toBe(100)
    expect(r.text.split("\n")[0]).toContain("seo: FAIL — https://example.sa · 1 صفحة · 2 خطأ · 1 تحذير")
    expect(renderSeoAudit(analyzeSeoPage(clean), 1, "x").passed).toBe(true)
    // التحذيراتُ وحدها لا تُسقط الحكم — تُخفض الدرجة.
    const warnedOnly = renderSeoAudit(analyzeSeoPage(page({ rendered: { imgNoAlt: 2, imgNoDims: 1 } })), 1, "x")
    expect(warnedOnly.passed).toBe(true)
    expect(warnedOnly.scores.SXO).toBe(95)
  })
})

describe("in-page script", () => {
  test("is one async function expression that parses, takes withSite, and carries no backtick", () => {
    expect(() => new Function(`return ${SEO_MEASURE_SCRIPT}`)).not.toThrow()
    expect(SEO_MEASURE_SCRIPT.startsWith("(async (withSite) =>")).toBe(true)
    expect(SEO_MEASURE_SCRIPT.includes("\x60")).toBe(false)
    // HTML الخام من الصفحة نفسِها، وملفّاتُ الموقع من الأصل نفسِه — لا وجهةَ أخرى.
    expect(SEO_MEASURE_SCRIPT).toContain("get(location.href)")
    expect(SEO_MEASURE_SCRIPT).toContain("get(location.origin + p)")
    expect(SEO_MEASURE_SCRIPT).not.toMatch(/fetch\("http/u)
  })
})
