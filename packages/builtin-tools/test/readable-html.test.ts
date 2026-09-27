/**
 * `fetch` على صفحة HTML (2026-09-27): كان يعيد أوّلَ 4000 محرفٍ من الخام — رأسَ الصفحة وأنماطَها — فتبدو فارغة.
 * الآن نصٌّ مقروء بروابطه، والسقفُ على المقروء، والبصمةُ على الخام. والنصُّ العاديّ باقٍ كما كان (توأمُ الاختبار القائم).
 */
import { expect, test } from "bun:test"
import { readableHtml } from "../src/readable-html"
import { networkFetchTool } from "../src/adapters"

const PAGE = `<!doctype html><html><head><title>Docs &amp; Guides</title><style>.x{color:red}</style>
<script>var secretToken = "should-not-appear"</script>${"<meta name='pad' content='" + "p".repeat(6000) + "'>"}</head>
<body><!-- hidden comment --><nav><a href="#top">Top</a></nav>
<h1>Test runner</h1><p>Bun&#x27;s runner is <b>fast</b>.</p>
<a href="https://bun.com/docs/test?a=1&amp;b=2">Read the docs</a> <a href="javascript:void(0)">noop</a>
<svg><text>vector noise</text></svg></body></html>`

test("an HTML page becomes readable text: title, content and links survive; head, script, style and comments do not", () => {
  const text = readableHtml(PAGE)
  expect(text.startsWith("Docs & Guides\n\n")).toBe(true)
  expect(text).toContain("Test runner")
  expect(text).toContain("Bun's runner is fast .")
  expect(text).toContain("[Read the docs](https://bun.com/docs/test?a=1&b=2)")
  for (const gone of ["secretToken", "color:red", "hidden comment", "vector noise", "javascript:", "pppp"]) expect(text).not.toContain(gone)
  // رابطُ المرساة والرابطُ البرمجيّ يبقى نصّهما بلا رابط.
  expect(text).toContain("Top")
  expect(text).not.toContain("](#top)")
})

test("the adapter returns the readable text for HTML — the first result is no longer cut off behind the head", async () => {
  const tool = networkFetchTool({
    lookupHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    requestFetch: (async () => new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as never,
  })
  const result = await tool.run({ url: "https://example.com/docs" }, { executionId: "fetch-html", mode: "BUILD" } as never)
  expect(result.ok).toBe(true)
  const output = result.output as { text: string; format?: string; sha256: string; bytes: number; truncated: boolean }
  expect(output.format).toBe("readable")
  expect(output.text).toContain("[Read the docs](https://bun.com/docs/test?a=1&b=2)")
  expect(output.text).not.toContain("<head>")
  expect(output.bytes).toBe(new TextEncoder().encode(PAGE).byteLength)
  expect(output.truncated).toBe(false)
  expect(output.sha256).toMatch(/^[a-f0-9]{64}$/)
})
