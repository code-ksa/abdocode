/**
 * الفجوة #1 (2026-09-27) — بحثٌ بلا مفتاح: صفحةُ DuckDuckGo الخفيفة بشكلها المقيس (العنوان ثمّ الرابطُ المعروض ثمّ المقتطف،
 * كلُّها روابطُ تحويلٍ `uddg=` إلى الهدف نفسِه) ⇦ نصٌّ مقروء بمحوّل `fetch` نفسِه ⇦ نتائجُ منظّمة بالرابط الحقيقيّ.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readableHtml } from "../../builtin-tools/src/readable-html"
import { formatKeyless, keylessSearchUrl, parseKeylessResults, targetOf } from "../src/mind/keyless-search"

const redirect = (url: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc123`
const result = (url: string, title: string, display: string, snippet: string) => `
<div class="result results_links web-result"><div class="links_main result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="${redirect(url)}">${title}</a></h2>
  <div class="result__extras"><div class="result__extras__url">
    <span class="result__icon"><a rel="nofollow" href="${redirect(url)}"><img src="//external-content.duckduckgo.com/ip3/x.ico" /></a></span>
    <a class="result__url" href="${redirect(url)}">${display}</a>
  </div></div>
  <a class="result__snippet" href="${redirect(url)}">${snippet}</a>
</div></div>`
const PAGE = `<html><head><title>bun test at DuckDuckGo</title><style>${"x".repeat(9000)}</style></head><body>
<form><select><option>Past Month</option></select></form>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Sponsored thing</a></div>
${result("https://bun.com/docs/test", "Test runner | Bun Docs", "bun.com/docs/test", "<b>Bun&#x27;s</b> fast, built-in, Jest-compatible <b>test</b> runner.")}
${result("https://bun.com/docs/test/writing-tests", "Writing tests | Bun", "bun.com/docs/test/writing-tests", "Define tests with a Jest-like API.")}
${result("https://github.com/oven-sh/bun/issues?q=test+runner", "Issues · oven-sh/bun", "github.com/oven-sh/bun/issues", "Bug reports about the test runner.")}
</body></html>`

test("DuckDuckGo results become structured items with the real target, the snippet and the display URL — ads and icons do not", () => {
  const items = parseKeylessResults(readableHtml(PAGE), 10)
  expect(items.map((i) => i.url)).toEqual(["https://bun.com/docs/test", "https://bun.com/docs/test/writing-tests", "https://github.com/oven-sh/bun/issues?q=test+runner"])
  expect(items[0]).toMatchObject({ title: "Test runner | Bun Docs", displayUrl: "bun.com/docs/test", snippet: "Bun's fast, built-in, Jest-compatible test runner." })
  expect(items.some((i) => /Sponsored|duckduckgo\.com/u.test(i.title + i.url))).toBe(false)
  expect(parseKeylessResults(readableHtml(PAGE), 2)).toHaveLength(2)
  const text = formatKeyless("bun test", items)
  expect(text).toContain("DuckDuckGo بلا مفتاح")
  expect(text).toContain("1. Test runner | Bun Docs\n   https://bun.com/docs/test\n   Bun's fast")
  // fetch إلى مواقع النتائج مرفوضٌ بحارس الخروج — فالتلميحُ يدلّ على الطريق الذي يعمل.
  expect(text).toContain("نفّذ: open <الرابط> ثمّ نفّذ: page")
})

test("the twins: a blocked or reshaped page yields no items (said, not invented), and only https targets are accepted", () => {
  expect(parseKeylessResults(readableHtml("<html><body><p>Please complete the challenge.</p></body></html>"), 5)).toEqual([])
  expect(targetOf("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)&rut=x")).toBeUndefined()
  expect(targetOf("//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fsettings&rut=x")).toBeUndefined()
  expect(targetOf("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x")).toBe("https://example.com/a?b=1")
  expect(keylessSearchUrl("bun test", "bun.com")).toBe("https://html.duckduckgo.com/html/?q=bun%20test%20site%3Abun.com")
  expect(formatKeyless("x", [])).toContain("لا نتائج")
})

test("wiring: without PSE keys the search runner goes through the kernel network adapter, behind plugins.keylessSearch, and never for images", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  const start = cli.indexOf("if (!googleSearchReady()) {\r\n            // الفجوة #1")
  expect(start).toBeGreaterThan(0)
  const branch = cli.slice(start, start + 1600)
  expect(branch).toContain('if (pluginOnNow("keylessSearch") && request.kind !== "image") {')
  // الجلبُ في المالك المشترك مع research (keylessResults)، والفرعُ يناديه.
  expect(branch).toContain("const { items, why } = await keylessResults(input, turnId, hooks.signal)")
  const helper = cli.slice(cli.indexOf("const keylessResults = async ("), cli.indexOf("const pseResults = async ("))
  expect(helper).toContain('runAdapterV("network", "network_fetch", { url: keylessSearchUrl(input.query, input.site) }')
  // الوجهةُ تُعلن لحارس الخروج قبل الجلب مباشرةً — ووحدها.
  expect(helper.indexOf("allowEgress(KEYLESS_HOST,")).toBeGreaterThan(0)
  expect(helper.indexOf("allowEgress(KEYLESS_HOST,")).toBeLessThan(helper.indexOf('runAdapterV("network", "network_fetch"'))
  expect(cli.match(/allowEgress\(KEYLESS_HOST/gu)).toHaveLength(1)
  // الرفضُ يُقال — لا نجاحَ بلا نتائج.
  expect(branch).toContain('detail: "keyless_search_empty"')
  // والتوافقُ مع البوّابة: الموافقةُ تُطلب قبل هذا الفرع لا بعده.
  expect(cli.lastIndexOf("const ok = await gate(turnId, spec.effect, `بحث Google: ${request.query}`)", start)).toBeGreaterThan(cli.lastIndexOf('if (spec.name === "search") {', start))
})
