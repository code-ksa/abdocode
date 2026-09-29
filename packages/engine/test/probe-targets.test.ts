import { describe, expect, test } from "bun:test"
import { probeTargets, probeUrls, renderProbe, snippetOf } from "../src/probe-targets"

// 09-29 — probe: فحصُ صفحات خادم التطوير كلِّها في نداءٍ واحد، محصورٌ في المضيف المحلّيّ.
describe("probe targets", () => {
  test("absolute loopback urls and /paths against the last origin; non-local targets are refused, not fetched", () => {
    const plan = probeTargets("http://localhost:3000/ /playground /dashboard http://127.0.0.1:5173/ /app https://example.com/x api", "http://127.0.0.1:3000")
    expect(plan.urls).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/playground",
      "http://localhost:3000/dashboard",
      "http://127.0.0.1:5173/",
      "http://127.0.0.1:5173/app",
    ])
    expect(plan.refused).toEqual(["https://example.com/x", "api"])
    expect(probeTargets("/api/models", "http://127.0.0.1:3000").urls).toEqual(["http://127.0.0.1:3000/api/models"])
    expect(probeTargets("probe localhost:3000/x", "http://127.0.0.1:3000").urls).toEqual(["http://localhost:3000/x"])
  })

  test("snippets: html gives the title and text, json is folded", () => {
    expect(snippetOf("text/html; charset=utf-8", "<html><head><title>OpenRouter Clone</title><style>x{}</style></head><body><h1>Playground</h1><script>1</script></body></html>")).toBe("«OpenRouter Clone» Playground")
    expect(snippetOf("application/json", '{\n "data": [1,\n 2]\n}')).toBe('{ "data": [1, 2] }')
  })

  test("live: probes a real local server in one call, reports status, type, redirects and failures", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path === "/") return new Response("<title>Home</title><p>hello</p>", { headers: { "content-type": "text/html" } })
        if (path === "/api") return new Response('{"ok":true}', { headers: { "content-type": "application/json" } })
        if (path === "/go") return new Response(null, { status: 302, headers: { location: "/" } })
        return new Response("nope", { status: 404 })
      },
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const plan = probeTargets(`${base}/ /api /go /missing`, base)
      const results = await probeUrls(plan.urls)
      const text = renderProbe(results, plan.refused)
      expect(text).toContain("probe: 3/4 تستجيب بنجاح")
      expect(text).toContain(`✓ 200 ${base}/ —`)
      expect(text).toContain("«Home» hello")
      expect(text).toContain(`✓ 200 ${base}/api —`)
      expect(text).toContain('{"ok":true}')
      expect(text).toContain(`✓ 302 ${base}/go —`)
      expect(text).toContain("⇒ /")
      expect(text).toContain(`✕ 404 ${base}/missing —`)
      const dead = await probeUrls(["http://127.0.0.1:1/"], fetch, 2_000)
      expect(dead[0]!.status).toBeUndefined()
      expect(renderProbe(dead, [])).toContain("لا استجابة")
    } finally {
      server.stop(true)
    }
  }, 20_000)
})
