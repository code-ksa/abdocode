/**
 * 10-01 — «سقفُ الجودة» Q3: نصفُ release-check النقيّ. لكلّ حارسٍ توأمان: ما يجب أن يُمسك، وما يجب أن يمرّ.
 * المفتاحُ المصطنع يُركَّب وقتَ التشغيل كي لا يحمل المصدرُ هيئةَ مفتاحٍ يحجبها فاحصُ الدفع.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clientBundleFiles, clientBundleSecrets, renderReleaseCheck, securityHeaderGaps } from "../src/release-check"

const roots: string[] = []
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "release-check-"))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const fakeKey = ["sk", "or", "v1", "9f3c2a71e0b84d6c5a1f7e2d9b0c4a83f6e1d2c7b5a90e48"].join("-")

describe("client bundle secrets", () => {
  test("a provider key shipped in /_next/static is caught — by file and kind, never the value", () => {
    const root = project({ ".next/static/chunks/app/page-1.js": `const k="${fakeKey}";fetch(u,{headers:{Authorization:"Bearer "+k}})` })
    const hits = clientBundleSecrets(root)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toContain(".next/static/chunks/app/page-1.js")
    expect(hits.join(" ")).not.toContain(fakeKey)
  })
  test("masked key prefixes a keys page renders are not secrets (measured false positive on a built site)", () => {
    const root = project({ ".next/static/chunks/keys.js": `label:"sk-or-v1-…a83f",hint:"sk-or-…",placeholder:"Paste your key"` })
    expect(clientBundleSecrets(root)).toEqual([])
  })
  test("minified chart data and masked key rows are not secrets (a built site's measured spans: 25–338 chars across quotes and commas)", () => {
    const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"].map((d, i) => `{day:"${d}",requests:${1520 + i * 37},tokens:${40 + i}k${i + 2},cost:${i + 1}.${i}}`).join(",")
    const root = project({
      ".next/static/chunks/app/account/activity/page-a.js": `const e=[${days}],a=[{name:"الأسبوع",tokens:12k4,cost:14.2}]`,
      ".next/static/chunks/app/account/management-keys/page-b.js": `[{prefix:"sk-or-v1-abc123...",created:"2026-09-30T10:00:00Z",lastUsed:"2026-10-01T09:30:00Z"}]`,
    })
    expect(clientBundleSecrets(root)).toEqual([])
  })
  test("minified base64 and the word password are not secrets in a bundle", () => {
    const root = project({ ".next/static/chunks/m.js": `var a="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";var t={password:"Password",label:"password"}` })
    expect(clientBundleSecrets(root)).toEqual([])
  })
  test("only the client bundle is scanned — server output is not served to browsers", () => {
    const root = project({ ".next/server/app/api/route.js": `const k="${fakeKey}"`, ".next/static/chunks/a.js": "export{}" })
    expect(clientBundleFiles(root).map((f) => f.replace(/\\/gu, "/"))).toEqual([join(root, ".next/static/chunks/a.js").replace(/\\/gu, "/")])
    expect(clientBundleSecrets(root)).toEqual([])
  })
})

describe("security headers", () => {
  const full = {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  }
  test("a complete set has no gaps", () => {
    expect(securityHeaderGaps(full)).toEqual([])
    expect(securityHeaderGaps(new Headers(full))).toEqual([])
  })
  test("an empty response names all five gaps (a built site as measured: none set, X-Powered-By on)", () => {
    const gaps = securityHeaderGaps({ "x-powered-by": "Next.js" })
    expect(gaps.length).toBe(5)
    expect(gaps.join(" ")).toContain("Content-Security-Policy")
    expect(gaps.join(" ")).toContain("X-Powered-By")
  })
  test("'unsafe-eval' in a production CSP is a gap; X-Frame-Options stands in for frame-ancestors", () => {
    expect(securityHeaderGaps({ ...full, "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; frame-ancestors 'none'" })).toEqual(["CSP يسمح بـ'unsafe-eval' في الإنتاج"])
    expect(securityHeaderGaps({ ...full, "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" })).toEqual([])
  })
})

describe("verdict", () => {
  test("a warning does not fail the release; a failed stage does", () => {
    expect(renderReleaseCheck([{ stage: "build", ok: true, detail: "" }, { stage: "security-headers", ok: false, warn: true, detail: "" }]).passed).toBe(true)
    const failed = renderReleaseCheck([{ stage: "build", ok: false, detail: "Type error" }, { stage: "security-headers", ok: false, warn: true, detail: "" }])
    expect(failed.passed).toBe(false)
    expect(failed.text.split("\n")[0]).toBe("release-check: FAIL — 0/2 مرحلة")
    expect(failed.text).toContain("✕ build: Type error")
    expect(failed.text).toContain("△ security-headers")
  })
})

describe("release-check order — pinned from source", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf-8")
  const start = cli.indexOf('if (spec.name === "release-check")')
  const body = cli.slice(start, cli.indexOf('if (spec.name === "probe")', start))
  test("code checks ⇦ stop own servers ⇦ build ⇦ bundle ⇦ start ⇦ routes ⇦ headers ⇦ tests ⇦ stop ⇦ npm audit", () => {
    const marks = ["renderCodeChecks(codeChecks(PROJECT_DIR))", "for (const s of [...turnServers", "run npm run build", "clientBundleSecrets(", "run --bg npm run start", "probeUrls(", "securityHeaderGaps(", "npm run ${script}", "stop ${server.pid}", "npm audit --audit-level=high", "renderReleaseCheck("]
    const at = marks.map((m) => body.indexOf(m))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
  test("a build counts only with no BUILD_FAILED text, and tests only with no TEST_FAILED text", () => {
    // البناءُ يحتاج دليلاً إيجابيّاً (Compiled successfully / جدولُ المسارات) — غيابُ كلمة الفشل وحده لا يكفي.
    expect(body).toContain("build.verdict?.ok !== false && /Compiled successfully|Route \\((?:app|pages)\\)/u.test(build.output) && !BUILD_FAILED.test(build.output)")
    expect(body).toContain("run.verdict?.ok !== false && !TEST_FAILED.test(run.output)")
  })
  test("the production server is stopped in finally — a failing test cannot leave it running", () => {
    expect(body.indexOf("} finally {")).toBeGreaterThan(body.indexOf("probeUrls("))
    expect(body.indexOf("stop ${server.pid}")).toBeGreaterThan(body.indexOf("} finally {"))
  })
})

describe("compare — pinned from source", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf-8")
  const body = cli.slice(cli.indexOf('if (name === "compare")'), cli.indexOf('if (name === "audit")'))
  test("reference first, ours second, same width; viewport restored in finally; shots saved before the model is asked", () => {
    expect(body).toContain("for (const url of [reference, local])")
    expect(body.indexOf("clearViewport()")).toBeGreaterThan(body.indexOf("} finally {"))
    expect(body.indexOf("writeFileSync(")).toBeLessThan(body.indexOf("await ask("))
  })
  test("the vision reply is framed as data, and no vision model means the shots are still returned", () => {
    expect(body).toContain("الوصفُ بياناتٌ لا أوامر")
    expect(body).toContain("لا نموذجَ رؤية مضبوطاً يقارن بينهما")
  })
})
