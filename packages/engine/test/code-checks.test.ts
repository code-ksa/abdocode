/**
 * 10-01 — فحوصُ الشيفرة قبل الإنتاج (Q2/Q3). لكلّ قاعدةٍ توأمان، ومعها الإيجابيُّ الكاذب الذي قيس على صفحة التوثيق.
 */
import { describe, expect, test } from "bun:test"
import { checkSources, maskSource, renderCodeChecks } from "../src/code-checks"

const P = "C:/p"
const run = (files: Record<string, string>, example?: string) => checkSources(P, Object.entries(files).map(([name, text]) => ({ path: `${P}/${name}`, text })), example).map((f) => `${f.severity}:${f.check}:${f.file}`)

describe("mask", () => {
  test("blanks comments, template text and (optionally) quoted strings — keeps ${…} expressions and line structure", () => {
    const src = "const a = 'x' // c\n/* b */ const t = \x60show ${process.env.KEY} here\x60\nconst s = \"y\""
    const bare = maskSource(src, { quoted: true })
    expect(bare.split("\n").length).toBe(3)
    expect(bare).toContain("${process.env.KEY}")
    expect(bare).not.toContain("show")
    expect(bare).not.toContain("// c")
    expect(bare).not.toContain("y\"")
    expect(maskSource(src, { quoted: false })).toContain("'x'")
  })
})

describe("client env", () => {
  test("a client component reading a server variable is an error; NEXT_PUBLIC_ and NODE_ENV are fine", () => {
    expect(run({ "src/app/x/page.tsx": "'use client'\nconst k = process.env.SECRET_KEY" })).toContain("error:client-env:src/app/x/page.tsx")
    // NEXT_PUBLIC_ يحتاج .env.example أيضاً (النشرُ يحتاجه) — يُعطى هنا كي يُعزل حكمُ العميل وحده.
    expect(run({ "src/app/x/page.tsx": "'use client'\nconst k = process.env.NEXT_PUBLIC_URL ?? process.env.NODE_ENV" }, "NEXT_PUBLIC_URL=\n")).toEqual([])
    expect(run({ "src/app/x/page.tsx": "const k = process.env.SECRET_KEY" }, "SECRET_KEY=\n")).toEqual([])
  })
  test("measured false positive: process.env inside a displayed code sample (template text) is not code", () => {
    const docs = "'use client'\nconst items = [{ code: \x60const r = await fetch(url, {\n  headers: { 'Authorization': 'Bearer ' + process.env.MODELS_API_KEY }\n})\x60 }]"
    expect(run({ "src/app/docs/page.tsx": docs }, "")).toEqual([])
  })
  test("process.env written inside an ordinary string (a help message) is text, not a read", () => {
    expect(run({ "src/app/x/page.tsx": "'use client'\nconst help = 'set process.env.SECRET_KEY on the server'" }, "")).toEqual([])
  })
  test("but process.env inside a template expression is real code", () => {
    expect(run({ "src/app/x/page.tsx": "'use client'\nconst h = \x60Bearer ${process.env.API_SECRET}\x60" })).toContain("error:client-env:src/app/x/page.tsx")
  })
})

describe("api routes", () => {
  test("reading a body without validation is a warning; with zod safeParse it passes", () => {
    expect(run({ "src/app/api/keys/route.ts": "export async function GET(request) { const b = await request.json(); return b }" })).toContain("warn:api-validation:src/app/api/keys/route.ts")
    expect(run({ "src/app/api/keys/route.ts": "import { z } from 'zod'\nconst S = z.object({ name: z.string() })\nexport async function GET(request) { const b = S.safeParse(await request.json()); return b }" })).toEqual([])
  })
  test("a mutating export without an auth trace is a warning; with a session check, or on the login route, it passes", () => {
    expect(run({ "src/app/api/keys/route.ts": "export async function DELETE() { db.delete() }" })).toContain("warn:api-auth:src/app/api/keys/route.ts")
    expect(run({ "src/app/api/keys/route.ts": "export async function DELETE() { const s = await getServerSession(); if (!s) return 401; db.delete() }" })).toEqual([])
    expect(run({ "src/app/api/auth/login/route.ts": "export async function POST() { return signIn() }" })).toEqual([])
    // التصديرُ في تعليقٍ ليس تصديراً، والمصادقةُ في تعليقٍ ليست مصادقة.
    expect(run({ "src/app/api/keys/route.ts": "// export async function DELETE() {}\nexport async function GET() {}" })).toEqual([])
    expect(run({ "src/app/api/keys/route.ts": "// getServerSession()\nexport async function POST() { db.put() }" })).toContain("warn:api-auth:src/app/api/keys/route.ts")
  })
  test("only route files are judged as routes", () => {
    expect(run({ "src/lib/db.ts": "export async function DELETE() {}\nconst b = await req.json()" })).toEqual([])
  })
})

describe("env example and localhost", () => {
  test("variables read by server code must be named in .env.example; a missing file is named", () => {
    expect(run({ "src/app/api/x/route.ts": "const k = \x60Bearer ${process.env.MODELS_API_KEY || 'demo'}\x60" }, "DATABASE_URL=\n")).toContain("warn:env-example:.env.example")
    expect(run({ "src/app/api/x/route.ts": "const k = process.env.MODELS_API_KEY" }, "MODELS_API_KEY=\n")).toEqual([])
    expect(run({ "src/lib/a.ts": "const k = process.env.DB" })).toContain("warn:env-example:.env.example")
  })
  test("a hard-coded localhost in a string is a warning; in a test, a config, a comment or a displayed sample it is not", () => {
    expect(run({ "src/app/api/x/route.ts": "fetch(u, { headers: { 'HTTP-Referer': 'http://localhost:3000' } })" })).toContain("warn:hardcoded-localhost:src/app/api/x/route.ts")
    expect(run({ "test/e2e.test.ts": "const base = 'http://localhost:3000'" })).toEqual([])
    expect(run({ "next.config.js": "const u = 'http://127.0.0.1:3000'" })).toEqual([])
    expect(run({ "src/lib/a.ts": "// fetch('http://localhost:3000')" })).toEqual([])
    expect(run({ "src/app/docs/page.tsx": "const c = \x60curl http://localhost:3000/api\nmore\x60" })).toEqual([])
  })
})

describe("render", () => {
  test("errors fail the stage, warnings alone are a named warning, nothing is clean", () => {
    expect(renderCodeChecks([])).toMatchObject({ ok: true, warn: false })
    const warnOnly = renderCodeChecks([{ check: "api-auth", severity: "warn", file: "a", detail: "d" }])
    expect(warnOnly).toMatchObject({ ok: true, warn: true })
    expect(warnOnly.detail).toContain("△ api-auth a: d")
    expect(renderCodeChecks([{ check: "client-env", severity: "error", file: "a", detail: "d" }])).toMatchObject({ ok: false, warn: false })
  })
})
