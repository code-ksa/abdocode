/**
 * الفجوة #2 (2026-09-27) — بحثٌ معمّق حتميّ: المقاطعُ من الصفحات المقروءة، مرتّبةٌ بالصلة، مرقّمةٌ بمصادرها — ولا شيءَ غيرها.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { formatResearch, pageTextOf, parseResearchCommand, passagesOf, selectEvidence, type ResearchSource } from "../src/mind/research"

const para = (words: string) => `${words} `.repeat(6).trim()
const PAGE_A = [
  "Home | Docs | Blog",
  para("Bun ships a built-in test runner that is compatible with Jest expect matchers and snapshot testing."),
  "",
  para("The weather today is sunny and there is nothing else to report about unrelated topics here."),
].join("\n")
const PAGE_B = [
  para("مشغّل الاختبارات في بن يدعم المحاكاة ووضع المراقبة وخطافات دورة الحياة مثل beforeEach وafterAll."),
  "",
  para("تاريخ المدينة القديمة يعود إلى قرون مضت وفيها أسواق كثيرة لا علاقة لها بالبرمجة."),
].join("\n")

test("measured on Bun's docs: a line made of links is navigation and never reaches the evidence; links inside prose keep their text", () => {
  const page = [
    "[Home](/) [Docs](/docs) [Guides](/guides) [Reference](/reference) [Blog](/blog)",
    "[Runtime](/docs) [Package Manager](/docs/pm) [Bundler](/docs/bundler) [Test Runner](/docs/test) [Guides](/guides)",
    para("Mocking replaces a dependency with a controlled implementation, see [module mocks](/docs/test/mocks#modules) for details."),
  ].join("\n")
  const passages = passagesOf(page)
  expect(passages.some((p) => /Package Manager|Reference/u.test(p))).toBe(false)
  expect(passages[0]).toContain("see module mocks for details")
  expect(passages.some((p) => p.includes("](/"))).toBe(false)
})

test("passages: navigation crumbs are dropped, paragraphs become bounded passages", () => {
  const passages = passagesOf(PAGE_A)
  expect(passages.some((p) => p.startsWith("Home | Docs"))).toBe(false)
  expect(passages.every((p) => p.length <= 701)).toBe(true)
  expect(passages.length).toBeGreaterThanOrEqual(2)
})

test("evidence is ranked by relevance across sources, numbered by source, and unrelated passages are left out", () => {
  const sources: ResearchSource[] = [
    { title: "Bun docs", url: "https://bun.com/docs/test", text: PAGE_A },
    { title: "دليل عربي", url: "https://example.org/ar", text: PAGE_B },
    { title: "Blocked", url: "https://blocked.example", failure: "HTTP 403" },
  ]
  const english = selectEvidence(sources, "Bun test runner Jest matchers snapshot")
  expect(english[0]).toMatchObject({ source: 1 })
  expect(english[0]!.text).toContain("built-in test runner")
  expect(english.some((e) => e.text.includes("weather"))).toBe(false)
  // سؤالٌ عربيّ بالتشكيل والهمزات يصل مقطعه العربيّ (التطبيعُ من مالك الترتيب).
  const arabic = selectEvidence(sources, "هل يدعم مُشغِّل الاختبارات المحاكاة؟")
  expect(arabic[0]).toMatchObject({ source: 2 })
  expect(arabic.some((e) => e.text.includes("المدينة القديمة"))).toBe(false)
  const text = formatResearch("Bun test runner", "DuckDuckGo بلا مفتاح", sources, english)
  expect(text).toContain("قُرئت 2 من 3 صفحات")
  expect(text).toContain("[3] Blocked — https://blocked.example (تعذّرت قراءتها: HTTP 403)")
  expect(text).toContain("[1] «")
  expect(text).toContain("استشهد بـ[n]")
})

test("no passage shares a word with the question: said as such, no evidence invented", () => {
  const sources: ResearchSource[] = [{ title: "Bun docs", url: "https://bun.com/docs/test", text: PAGE_A }]
  expect(selectEvidence(sources, "zzqx quantum pottery")).toEqual([])
  expect(formatResearch("zzqx", "Google", sources, [])).toContain("لا مقطعَ يطابق كلماتِ السؤال")
})

test("one source cannot swallow the evidence: at most three passages each", () => {
  const long = Array.from({ length: 8 }, (_, i) => para(`Bun test runner detail number ${i} explains matchers and snapshots`)).join("\n\n")
  const evidence = selectEvidence([{ title: "A", url: "https://a.example", text: long }, { title: "B", url: "https://b.example", text: PAGE_A }], "Bun test runner matchers")
  expect(evidence.filter((e) => e.source === 1)).toHaveLength(3)
  expect(evidence.some((e) => e.source === 2)).toBe(true)
})

test("the command and the fetch receipt are parsed exactly", () => {
  expect(parseResearchCommand("how does bun test mock modules --pages 9")).toEqual({ question: "how does bun test mock modules", pages: 6 })
  expect(parseResearchCommand("ما الفرق بين vitest و bun test")).toEqual({ question: "ما الفرق بين vitest و bun test", pages: 4 })
  expect(() => parseResearchCommand("  ")).toThrow()
  const receipt = "Title\n\n[Read the docs](https://bun.com/x) about mocks\n… [قُصّ الخرج بحدٍّ معلن]\nبصمة الدليل: abc\nدليل عامل Rust: network_fetch"
  expect(pageTextOf(receipt)).toBe("Title\n\n[Read the docs](https://bun.com/x) about mocks")
})

test("wiring: behind its key and the gate, pages are read through the kernel adapter, each result host opened only while it is read", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  const start = cli.indexOf('if (spec.name === "research") {')
  expect(start).toBeGreaterThan(0)
  const branch = cli.slice(start, start + 4200)
  const order = ['if (!pluginOnNow("research"))', "const ok = await gate(turnId, spec.effect, `بحثٌ معمّق:", "const release = allowEgressWhile(new URL(item.url).hostname", 'runAdapterV("network", "network_fetch", { url: item.url }', "} finally { release() }", "selectEvidence(sources, request.question)"]
  let at = -1
  for (const step of order) { const next = branch.indexOf(step); expect(next, step).toBeGreaterThan(at); at = next }
  // النتائجُ من مالكٍ واحد مع search — لا نسخةَ ثانية من جلب DuckDuckGo.
  expect(cli.split('runAdapterV("network", "network_fetch", { url: keylessSearchUrl(').length - 1).toBe(1)
  expect(branch).toContain("await keylessResults(input, turnId, hooks.signal)")
})

test("measured live: the page title repeated in a marketing paragraph does not buy it first place", () => {
  const marketing = para("How to Write Tests with Bun Test Runner Built for how you work. How to Write Tests with Bun Test Runner")
  const docs = para("mock.module() replaces a module; mock.restore() restores every mock created with jest.fn in the bun test runner.")
  const evidence = selectEvidence([{ title: "How to Write Tests with Bun Test Runner - oneuptime.com", url: "https://o.example", text: marketing }, { title: "Mocks | Bun Docs", url: "https://bun.com/docs/test/mocks", text: docs }], "how does the bun test runner mock modules")
  expect(evidence[0]).toMatchObject({ source: 2 })
  // المعروضُ هو المقطعُ كما قُرئ — النزعُ للترتيب وحده.
  expect(evidence.find((e) => e.source === 1)?.text ?? "").not.toContain("  ")
})
