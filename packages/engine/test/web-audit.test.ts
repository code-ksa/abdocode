/**
 * 10-01 — «سقفُ الجودة» Q1: قواعدُ scripts/ui-audit/lib.mjs منقولةً + الجديدة. لكلّ قاعدةٍ توأمان: قياسٌ يفشل وقياسٌ ينجح.
 * القياساتُ من موقعٍ بناه عبدو كود (Next.js، عربيّ) كما قاستها العدّة.
 */
import { describe, expect, test } from "bun:test"
import { MEASURE_SCRIPT, WEB_STANDARDS_BRIEF, analyzeLinks, analyzePage, renderAudit, routesFromManifest, tailwindMajor, serverOlderThanBuild, staleBuildCause, tailwindV4DirectiveFindings, tailwindV4VarFindings, type PageMeasurement } from "../src/web-audit"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const clean: PageMeasurement = {
  status: 200, consoleErrors: [], failedRequests: [], runawayRequests: 0, lang: "ar", dir: "rtl",
  overflow: { default: { scrollWidth: 390, clientWidth: 390, culprit: null }, scaled: { scrollWidth: 390, clientWidth: 390, culprit: null } },
  inlineDvh: false, textLength: 900, h1Count: 1, imgNoAlt: 0, unnamedControls: [], unlabeledFields: [], overlaps: [],
}
const checks = (m: Partial<PageMeasurement>) => analyzePage({ ...clean, ...m }, { path: "/", width: 390 }).filter((f) => f.severity !== "info").map((f) => `${f.severity}:${f.check}`)

describe("web audit — one page at one width", () => {
  test("the clean twin produces no finding", () => {
    expect(checks({})).toEqual([])
  })

  test("measured on a built site: horizontal overflow names its culprit (RTL overflows to the left)", () => {
    const f = analyzePage({ ...clean, overflow: { default: { scrollWidth: 449, clientWidth: 360, culprit: "path width=5 x=-147" }, scaled: { scrollWidth: 1217, clientWidth: 360, culprit: "path width=8 x=-390" } } }, { path: "/", width: 360 })
    expect(f.map((x) => `${x.severity}:${x.check}`)).toEqual(["error:overflow", "warn:overflow@44px"])
    expect(f[0]!.detail).toContain("x=-147")
  })

  test("console errors, failed requests and runaway requests are errors", () => {
    expect(checks({ consoleErrors: ["Failed to load resource: 404"] })).toEqual(["error:console-errors"])
    expect(checks({ failedRequests: ["404 /favicon-32.png"] })).toEqual(["error:failed-requests"])
    expect(checks({ runawayRequests: 7 })).toEqual(["error:runaway-requests"])
    expect(checks({ runawayRequests: 6 })).toEqual([])
  })

  test("lang=ar without rtl, and a missing lang", () => {
    expect(checks({ dir: "ltr" })).toEqual(["error:dir"])
    expect(checks({ lang: null })).toEqual(["warn:lang"])
    expect(checks({ lang: "en", dir: "ltr" })).toEqual([])
  })

  test("text overlap, h1, alt, unnamed controls and unlabeled fields", () => {
    expect(checks({ overlaps: ["span «Store» ⟂ a «Models»"] })).toEqual(["error:text-overlap"])
    expect(checks({ h1Count: 0 })).toEqual(["warn:h1"])
    expect(checks({ h1Count: 2 })).toEqual(["warn:h1"])
    expect(checks({ imgNoAlt: 3 })).toEqual(["error:img-alt"])
    expect(checks({ unnamedControls: ["button.icon"] })).toEqual(["error:unnamed-control"])
    expect(checks({ unlabeledFields: ["input#search"] })).toEqual(["error:unlabeled-field"])
  })

  test("status, no response and an almost empty render", () => {
    expect(checks({ status: 500 })).toEqual(["error:status"])
    expect(checks({ status: 404 })).toEqual(["warn:status"])
    expect(analyzePage({ ...clean, status: 0, error: "net::ERR_CONNECTION_REFUSED" }, { path: "/", width: 390 }).map((f) => f.check)).toEqual(["status"])
    expect(checks({ textLength: 12, h1Count: 0 })).toEqual(["warn:rendered-text"])
  })
})

describe("web audit — site level", () => {
  test("measured on a built site: twenty links to /blog answer 404", () => {
    const f = analyzeLinks([{ url: "/blog", status: 404 }, { url: "/blog/gpt-4o-launch", status: 404 }, { url: "/models", status: 200 }])
    expect(f.map((x) => x.check)).toEqual(["broken-links"])
    expect(f[0]!.measured).toBe("2")
    expect(analyzeLinks([{ url: "/models", status: 200 }])).toEqual([])
  })

  test("routes come from the Next.js build, without dynamic, api or internal paths", () => {
    expect(routesFromManifest({ "/page": "/", "/models/page": "/models", "/models/[provider]/[model]/page": "/models/[provider]/[model]", "/api/health/route": "/api/health", "/favicon.ico/route": "/favicon.ico", "/_not-found/page": "/_not-found" })).toEqual(["/", "/models"])
    expect(routesFromManifest(undefined)).toEqual(["/"])
  })

  test("the verdict passes only without errors; warnings are named and do not block", () => {
    const warnOnly = analyzePage({ ...clean, lang: null }, { path: "/", width: 390 })
    expect(renderAudit(warnOnly, 1, [390]).passed).toBe(true)
    const failing = renderAudit([...warnOnly, ...analyzeLinks([{ url: "/blog", status: 404 }])], 1, [390])
    expect(failing.passed).toBe(false)
    expect(failing.text.startsWith("audit: FAIL")).toBe(true)
    expect(failing.text).toContain("broken-links")
  })

  test("the in-page script is plain JavaScript that returns JSON with every measured field", () => {
    expect(() => new Function(`return ${MEASURE_SCRIPT}`)).not.toThrow()
    for (const field of ["overflow", "lang", "dir", "inlineDvh", "links", "textLength", "h1Count", "imgNoAlt", "unnamedControls", "unlabeledFields", "overlaps"]) expect(MEASURE_SCRIPT).toContain(field)
  })
})

// 10-01 (Q4) — معاييرُ الواجهات في طبقة المشروع: كلُّ بندٍ يقابل عيباً قيس على موقعٍ بناه عبدو كود.
describe("web standards brief", () => {
  test("names the measured defects and the gate that enforces them", () => {
    for (const must of ["audit: PASS", "درجُ الجوّال بخلفيّةٍ معتمة", "min-w-0", "dir=\"rtl\"", "WCAG 2.2", "frame-ancestors", "zod", "llms.txt", "لا رابطَ داخليّاً إلى صفحةٍ غير موجودة", "release-check"]) expect(WEB_STANDARDS_BRIEF).toContain(must)
    // يدخل طبقةَ المشروع (16k) بهامشٍ واسع.
    expect(new TextEncoder().encode(WEB_STANDARDS_BRIEF).length).toBeLessThan(4_096)
  })
  test("injected into the project layer only for a selected web project with the gate on, and never into a reviewer call", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain('projectInstructionBlock + (projectSelected && hooks.reviewSystem === undefined && webQualityOn() ? `\\n${WEB_STANDARDS_BRIEF}\\n` : "")')
    expect(cli).toContain('const webQualityOn = (): boolean => pluginOnNow("auditGate") && ["next", "vite-react", "static-html"].includes(detectStackForProject(PROJECT_DIR, "").stack.id)')
    expect(cli.split('pluginOnNow("auditGate")').length - 1).toBe(1)
    expect(cli).toContain("const web = webQualityOn()")
  })
})

// 10-01 — مقيس على الموقع أثناء Sprint 14: 73 صنفاً `-[--x]` في ثلاثة ملفّات كتبها عبدو كود؛ Tailwind 4 يترجمها قيمةً باطلة (الخلفيةُ شفّافة).
describe("tailwind 4 arbitrary var classes", () => {
  const header = "<header className=\"sticky bg-[--bg]/80 border-b border-[--border-soft]\">\n<div className=\"fixed bg-[--surface] md:hover:bg-[--surface-raised]\" />"
  test("in a Tailwind 4 project each file with the old syntax is one error, with its first line, count and the v4 spelling", () => {
    const f = tailwindV4VarFindings([{ path: "src/components/layout/header.tsx", text: header }], 4)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ path: "src/components/layout/header.tsx:1", check: "tailwind-v4-var", severity: "error", expected: "bg-(--bg)/80" })
    expect(f[0]!.measured).toStartWith("4×")
    // مقيس: الصنفُ بتعديلٍ = نداءٌ لكلّ صنف (18 في ملفٍّ واحد) — الإصلاحُ دفعةً واحدة.
    expect(f[0]!.detail).toContain("أصلح الملفَّ كلَّه دفعةً واحدة")
    expect(renderAudit(f, 1, [390]).passed).toBe(false)
  })
  test("the v4 spellings, Tailwind 3, plain CSS files and non-var arbitrary values pass", () => {
    expect(tailwindV4VarFindings([{ path: "a.tsx", text: "<div className=\"bg-(--surface) bg-[var(--surface)] w-[320px] bg-[#0a0d14]\" />" }], 4)).toEqual([])
    expect(tailwindV4VarFindings([{ path: "a.tsx", text: header }], 3)).toEqual([])
    expect(tailwindV4VarFindings([{ path: "a.tsx", text: header }], undefined)).toEqual([])
    expect(tailwindV4VarFindings([{ path: "globals.css", text: ".x{background:var(--bg)} [--bg]" }], 4)).toEqual([])
    // متغيّراتُ cva في ‎.ts‎ أصنافٌ حقيقيّة تُفحص؛ والاختباراتُ لا.
    expect(tailwindV4VarFindings([{ path: "src/components/ui/variants.ts", text: "export const v = { primary: \"bg-[--primary]\" }" }], 4)).toHaveLength(1)
    expect(tailwindV4VarFindings([{ path: "src/components/ui/button.test.tsx", text: "expect(cls).toBe(\"bg-[--primary]\")" }, { path: "test/ui.spec.ts", text: "\"bg-[--x]\"" }], 4)).toEqual([])
  })
  test("the major version is read from dependencies or devDependencies", () => {
    expect(tailwindMajor(JSON.stringify({ devDependencies: { tailwindcss: "^4.3.3" } }))).toBe(4)
    expect(tailwindMajor(JSON.stringify({ dependencies: { tailwindcss: "3.4.1" } }))).toBe(3)
    expect(tailwindMajor(JSON.stringify({ dependencies: { next: "14" } }))).toBeUndefined()
    expect(tailwindMajor("not json")).toBeUndefined()
  })
  test("audit runs it over the project sources, and the brief names the v4 spelling", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("findings.push(...tailwindV4VarFindings(sourceFiles(PROJECT_DIR)")
    expect(cli.indexOf("tailwindV4VarFindings(sourceFiles(PROJECT_DIR)")).toBeLessThan(cli.indexOf("const report = renderAudit(findings, routes.length, widths).text"))
    expect(WEB_STANDARDS_BRIEF).toContain("bg-(--surface)")
  })
})

// 10-01 — جذرُ الفيضان لا ورقتُه. مقيس في متصفّحٍ حقيقيّ (RTL، 360px، عنصرٌ بعرض 1000 ودرجٌ تحت position:fixed):
// «root section.hero > div.stats > strong.badge width=1000 x=-656 «أكثر من 300 نموذج»» — والدرجُ مستبعَد.
describe("overflow culprit", () => {
  test("names the root overflowing element with its parents and text, and skips what sits under position:fixed", () => {
    expect(MEASURE_SCRIPT).toContain('if (el.parentElement && outs.has(el.parentElement)) continue;')
    expect(MEASURE_SCRIPT).toContain('getComputedStyle(p).position === "fixed"')
    expect(MEASURE_SCRIPT).toContain('return "root " + [...chain, elLabel(root.el)].join(" > ")')
  })
  test("a multi-line console error is one line in the report (a pretty-printed ZodError filled 41 lines)", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain(".map((c) => c.text.replace(/\\s+/gu, \" \").trim().slice(0, 160))")
  })
})


// 10-01 — مقيس: النموذجُ كتب «@tailwind base;» في globals.css لمشروع Tailwind 4 فانكسر البناء، ثمّ أنزل Tailwind إلى 3.4.
describe("tailwind 4 with v3 directives", () => {
  const css = "/* tokens */\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --bg: #000 }"
  test("a v4 project's CSS with @tailwind directives is one error per file, at the first directive, with the v4 entry point", () => {
    const f = tailwindV4DirectiveFindings([{ path: "src/app/globals.css", text: css }], 4)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ path: "src/app/globals.css:2", check: "tailwind-v4-directive", severity: "error", measured: "3× @tailwind base",expected: '@import "tailwindcss";' })
    expect(renderAudit(f, 1, [390]).passed).toBe(false)
  })
  test("Tailwind 3, the v4 import, and a comment that mentions the directive mid-line pass", () => {
    expect(tailwindV4DirectiveFindings([{ path: "a.css", text: css }], 3)).toEqual([])
    expect(tailwindV4DirectiveFindings([{ path: "a.css", text: '@import "tailwindcss";\n@theme { --color-border: #222; }' }], 4)).toEqual([])
    expect(tailwindV4DirectiveFindings([{ path: "a.css", text: "/* replaced @tailwind base; with the import */" }], 4)).toEqual([])
  })
  test("audit reads the project's CSS for it, and the brief names the v4 entry point and forbids the downgrade", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("findings.push(...tailwindV4DirectiveFindings(sourceFiles(PROJECT_DIR, 200, /\\.css$/u)")
    expect(WEB_STANDARDS_BRIEF).toContain('@import "tailwindcss";')
    expect(WEB_STANDARDS_BRIEF).toContain("ولا تُنزل الإصدار")
  })
})

// 10-01 — مقيس حيّاً: audit بعد بناءٍ والخادمُ أُقلع قبله = 31 خطأً كلُّها 404/400 على /_next/static وChunkLoadError.
describe("a server started before the last build", () => {
  const measured = analyzePage({ ...clean, consoleErrors: ["ChunkLoadError: Loading chunk 211 failed."], failedRequests: ["404 /_next/static/css/45892a67d2ed7f77.css", "404 /_next/static/chunks/211-6d33e5220baa2aa9.js"] }, { path: "/models", width: 360 })
  const home = analyzePage({ ...clean, failedRequests: ["400 /_next/static/css/ce57a12b5ee05285.css"] }, { path: "/", width: 390 })
  test("the audit names the one cause above the list, and the verdict stays FAIL", () => {
    const report = renderAudit([...measured, ...home], 2, [360, 390])
    expect(report.passed).toBe(false)
    const lines = report.text.split("\n")
    expect(lines[1]).toStartWith("⚠ السببُ المرجَّح: الخادمُ أُقلع قبل آخر `next build`")
    expect(lines[1]).toContain("على 2 صفحة")
    expect(lines[1]).toContain("run --bg npm run start")
  })
  test("a failed request that is not a build asset gets no such cause", () => {
    expect(staleBuildCause(analyzePage({ ...clean, failedRequests: ["404 /favicon-32.png", "500 /api/models"] }, { path: "/", width: 390 }))).toBeUndefined()
    expect(renderAudit(analyzePage({ ...clean, failedRequests: ["404 /favicon-32.png"] }, { path: "/", width: 390 }), 1, [390]).text).not.toContain("السببُ المرجَّح")
  })
})

// 10-01 — مقيس حيّاً: start ⇦ audit ⇦ تعديل ⇦ build ⇦ audit بلا إعادة تشغيل = الأرقامُ نفسُها (62/35) لأنّ الخادمَ يقدّم البناءَ القديم.
describe("a production server older than the last build", () => {
  const start = { display: "npm run start", port: 3000, pid: 4242, alive: true, startedAt: 1_000 }
  test("is named above the results with how long before the build it started and the restart commands", () => {
    const line = serverOlderThanBuild([start], 61_000)!
    expect(line).toContain("«npm run start» على :3000 (pid 4242)")
    expect(line).toContain("بـ60 ث")
    expect(line).toContain("stop 4242")
    expect(line).toContain("run --bg npm run start")
  })
  test("a dev server, a server started after the build, no build yet, or a dead server get no such line", () => {
    expect(serverOlderThanBuild([{ ...start, display: "npm run dev" }], 61_000)).toBeUndefined()
    expect(serverOlderThanBuild([{ ...start, display: "npm run start:dev" }], 61_000)).toBeUndefined()
    expect(serverOlderThanBuild([{ ...start, startedAt: 70_000 }], 61_000)).toBeUndefined()
    expect(serverOlderThanBuild([start], 0)).toBeUndefined()
    expect(serverOlderThanBuild([{ ...start, alive: false }], 61_000)).toBeUndefined()
  })
  test("audit compares the managed servers with the last successful build, and the servers record when they started", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("const olderServer = serverOlderThanBuild([...turnServers.snapshot(), ...devServers.snapshot()], sprintEvidence.buildAt)")
    expect(cli).toContain("return olderServer === undefined ? report : `${olderServer}\\n${report}`")
    const managed = readFileSync(join(import.meta.dir, "../src/managed-server.ts"), "utf8")
    expect(managed).toContain("const managed: ManagedProcess = { proc, port, display, startedAt: Date.now() }")
  })
})

// 10-02 — measured: rewriting the root layout dropped `import "./globals.css"`; the whole site rendered with browser defaults
// (default-blue underlined links, no layout) and no audit check turned red, because nothing overflowed or overlapped.
describe("unstyled page", () => {
  test("few style rules, or most links in the browser's default blue, is an error; a styled page and an old measurement are not", () => {
    expect(checks({ styleRules: 3, linkCount: 22, uaLinks: 22 })).toContain("error:unstyled")
    expect(checks({ styleRules: 4, linkCount: 0, uaLinks: 0 })).toContain("error:unstyled")
    // the stylesheet loaded but the links still default-blue: still unstyled for the reader
    expect(checks({ styleRules: 400, linkCount: 10, uaLinks: 8 })).toContain("error:unstyled")
    // twins: a styled page, a page with only a couple of default links, and a measurement from before the field existed
    expect(checks({ styleRules: 640, linkCount: 30, uaLinks: 0 })).not.toContain("error:unstyled")
    expect(checks({ styleRules: 640, linkCount: 4, uaLinks: 3 })).not.toContain("error:unstyled")
    expect(checks({})).not.toContain("error:unstyled")
    const f = analyzePage({ ...clean, styleRules: 3, linkCount: 22, uaLinks: 22 }, { path: "/workspaces/default", width: 1366 }).find((x) => x.check === "unstyled")!
    expect(f.measured).toBe("3 rules · 22/22 default-blue links")
    expect(f.detail).toContain("root layout imports the global stylesheet")
  })
  test("cli hands the three fields from the measurement to analyzePage (they were dropped once, and no unit test saw it)", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    expect(cli).toContain('...(typeof m.styleRules === "number" ? { styleRules: m.styleRules, linkCount: Number(m.linkCount ?? 0), uaLinks: Number(m.uaLinks ?? 0) } : {}),')
  })
  test("audit with no managed server names the cause and the command, not 'no surface, use ui'", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    expect(cli).toContain("${name} يحتاج خادمَ المشروع يعمل تحت إدارة النواة ولا خادمَ الآن")
    expect(cli).toContain('} else if (name === "audit" || name === "shot" || name === "compare") {')
  })
  test("the measurement script collects the three fields", () => {
    expect(MEASURE_SCRIPT).toContain("styleRules, linkCount: shownLinks.length, uaLinks,")
    expect(MEASURE_SCRIPT).toContain('if (r.type === 5) continue;')
  })
})
