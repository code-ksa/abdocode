/**
 * 10-01 — «سقفُ الجودة» Q2/Q3: ما يقرؤه المشرفُ في الشيفرة قبل الرفع للإنتاج — فحوصٌ ثابتة حتميّة تدخل release-check.
 * معاييرُ الخلفيّة والأمان والرفع للإنتاج (أكتوبر 2026).
 *
 * - مسارُ API يقرأ جسماً بلا تحقّق (zod/valibot/yup/ajv أو safeParse/parse) ⇦ تحذير.
 * - مسارٌ يغيّر بيانات (POST/PUT/PATCH/DELETE) بلا أثرٍ لمصادقة ⇦ تحذير (مسارُ تسجيل الدخول نفسُه والـwebhook الموقَّع مستثنيان بالاسم).
 * - ملفّ "use client" يقرأ process.env غيرَ NEXT_PUBLIC_ ⇦ خطأ: القيمةُ undefined في المتصفّح (Next لا يحقن غيرَ العامّ) — ميزةٌ مكسورة في الإنتاج.
 * - متغيّرُ بيئةٍ تقرؤه الشيفرة وليس في .env.example ⇦ تحذير (النشرُ على خادمٍ جديد يفشل صامتاً).
 * - http://localhost أو 127.0.0.1 مكتوبٌ في الشيفرة (خارج الاختبارات والإعداد) ⇦ تحذير.
 * لا يُقرأ node_modules ولا .next ولا ملفٌّ أكبر من 512KB.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export type CodeCheckSeverity = "error" | "warn"
export interface CodeFinding { readonly check: string; readonly severity: CodeCheckSeverity; readonly file: string; readonly detail: string }

const SKIP_DIR = /^(?:node_modules|\.next|\.git|dist|build|out|coverage|\.turbo|\.vercel)$/u
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u
const TEST_FILE = /(?:^|[\\/])(?:test|tests|__tests__|e2e|cypress|playwright)[\\/]|\.(?:test|spec)\.[jt]sx?$/u
const CONFIG_FILE = /(?:^|[\\/])(?:next|vite|vitest|jest|playwright|tailwind|postcss|eslint)\.config\.[cm]?[jt]s$|(?:^|[\\/])\.env/u

/** ملفّاتُ المصدر في المشروع (بلا التبعيّات ولا المُخرجات)، بسقف عدد. */
export function sourceFiles(projectDir: string, cap = 3000): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (out.length >= cap) return
      if (SKIP_DIR.test(name)) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (SOURCE.test(name) && st.size <= 512 * 1024) out.push(full)
    }
  }
  walk(projectDir)
  return out
}

const READS_BODY = /\b(?:req|request)\s*\.\s*(?:json|formData|text)\s*\(/u
const VALIDATES = /\bz\s*\.\s*(?:object|string|number|array|enum|union|discriminatedUnion)\b|\.(?:safeParse|parseAsync|safeParseAsync)\s*\(|\bSchema\s*\.\s*parse\s*\(|from\s+["'](?:zod|valibot|yup|ajv|@sinclair\/typebox|superstruct|joi)["']|\bvalidate[A-Z]\w*\s*\(/u
const MUTATING_EXPORT = /export\s+(?:async\s+)?(?:function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/gu
const AUTH_TRACE = /\b(?:auth|getServerSession|getSession|currentUser|requireAuth|requireUser|verifyToken|verifySession|validateApiKey|authenticate[A-Z]?\w*|checkAuth|withAuth|isAuthenticated)\s*\(|\bheaders?\b[^\n]{0,60}\bauthorization\b|\bauthorization\b[^\n]{0,60}\bheaders?\b|\bBearer\b|cookies\(\)\s*\.get\(|\bsession\b|\bapiKey\b|\bapi_key\b/iu
const AUTH_EXEMPT_ROUTE = /[\\/]api[\\/](?:auth|login|logout|signup|signin|register|webhooks?|health|status)(?:[\\/]|$)/iu
const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/u
const ENV_READ = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b|\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/gu
const LOCALHOST = /["']https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^"'\n]*["']/u
const BUILTIN_ENV = new Set(["NODE_ENV", "NEXT_RUNTIME", "PORT", "HOSTNAME", "CI", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "TZ", "TEST_BASE_URL"])

const rel = (projectDir: string, file: string): string => relative(projectDir, file).replace(/\\/gu, "/")

/**
 * الشيفرةُ لا النصّ — مقيس 10-01 على صفحة التوثيق في الموقع: `process.env.MODELS_API_KEY` داخل قالبٍ نصّيّ يُعرض للقارئ مثالاً
 * حُسب «عميلاً يقرأ متغيّراً سرّيّاً» (خطأ) و«.env.example ينقصه» (تحذير) — فحصٌ يسمّي نصَّ التوثيق عيباً يدفع الوكيلَ إلى إصلاحٍ خاطئ.
 * يُفرَّغ هنا: التعليقات، ومحتوى القوالب `…` إلا تعبيراتِها ${…} (شيفرةٌ حقيقيّة)، و— حين `quoted` — محتوى '…' و"…". الأطوالُ والأسطرُ تُحفظ.
 */
export function maskSource(text: string, options: { readonly quoted: boolean }): string {
  let out = ""
  let mode: "code" | "sq" | "dq" | "tpl" | "line" | "block" = "code"
  let depth = 0
  const exprAt: number[] = []
  for (let i = 0; i < text.length; ) {
    const c = text[i]!
    const d = text[i + 1]
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { mode = "block"; out += "  "; i += 2; continue }
      if (c === "'" || c === "\"" || c === "\x60") { mode = c === "'" ? "sq" : c === "\"" ? "dq" : "tpl"; out += c; i += 1; continue }
      if (c === "{") depth += 1
      else if (c === "}") {
        if (exprAt.length > 0 && exprAt[exprAt.length - 1] === depth) { exprAt.pop(); mode = "tpl"; out += c; i += 1; continue }
        depth -= 1
      }
      out += c; i += 1; continue
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += c } else out += " "; i += 1; continue }
    if (mode === "block") { if (c === "*" && d === "/") { mode = "code"; out += "  "; i += 2; continue } out += c === "\n" ? "\n" : " "; i += 1; continue }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : "\""
      if (c === "\\") { out += options.quoted ? "  " : c + (d ?? ""); i += 2; continue }
      if (c === quote || c === "\n") { mode = "code"; out += c; i += 1; continue }
      out += options.quoted ? " " : c; i += 1; continue
    }
    if (c === "\\") { out += "  "; i += 2; continue }
    if (c === "\x60") { mode = "code"; out += c; i += 1; continue }
    if (c === "$" && d === "{") { exprAt.push(depth); mode = "code"; out += "${"; i += 2; continue }
    out += c === "\n" ? "\n" : " "; i += 1
  }
  return out
}

/** فحوصُ الشيفرة على ملفّاتٍ معطاة (للاختبار) — أو على المشروع كلِّه بـcodeChecks. */
export function checkSources(projectDir: string, files: readonly { readonly path: string; readonly text: string }[], envExample: string | undefined): CodeFinding[] {
  const out: CodeFinding[] = []
  const serverEnv = new Set<string>()
  for (const f of files) {
    const name = rel(projectDir, f.path)
    // بلا تعليقاتٍ ولا قوالب: للتحقّق والمصادقة والعنوان المحلّيّ (السلاسلُ العاديّة باقية: from "zod"، 'http://localhost').
    const code = maskSource(f.text, { quoted: false })
    // وبلا سلاسلَ أيضاً: لما هو شيفرةٌ وحدها (قراءةُ الجسم، البيئة، التصديرات).
    const bare = maskSource(f.text, { quoted: true })
    const isRoute = /(?:^|\/)app\/api\/.*\/route\.[jt]sx?$|(?:^|\/)pages\/api\//u.test(name)
    if (isRoute) {
      if (READS_BODY.test(bare) && !VALIDATES.test(code)) out.push({ check: "api-validation", severity: "warn", file: name, detail: "يقرأ جسمَ الطلب بلا تحقّق — z.object(...).safeParse(body) ثمّ 400 بخطأ مسمّى" })
      const mutating = [...bare.matchAll(MUTATING_EXPORT)].map((m) => m[1]!)
      if (mutating.length > 0 && !AUTH_EXEMPT_ROUTE.test(`/${name}`) && !AUTH_TRACE.test(code)) out.push({ check: "api-auth", severity: "warn", file: name, detail: `${mutating.join("/")} بلا أثرٍ لمصادقة — مسارٌ يغيّر بياناتٍ يتحقّق من الجلسة أو المفتاح قبل أيّ كتابة` })
    }
    const client = USE_CLIENT.test(f.text)
    for (const m of bare.matchAll(ENV_READ)) {
      const v = m[1] ?? m[2]!
      if (client && !v.startsWith("NEXT_PUBLIC_") && !BUILTIN_ENV.has(v)) out.push({ check: "client-env", severity: "error", file: name, detail: `"use client" يقرأ process.env.${v} — في المتصفّح undefined (Next يحقن NEXT_PUBLIC_ وحده)؛ اقرأه في مكوّن خادمٍ أو مسار API` })
      if (!BUILTIN_ENV.has(v) && !TEST_FILE.test(name)) serverEnv.add(v)
    }
    if (!TEST_FILE.test(name) && !CONFIG_FILE.test(name) && LOCALHOST.test(code)) out.push({ check: "hardcoded-localhost", severity: "warn", file: name, detail: `عنوانٌ محلّيٌّ مكتوب (${LOCALHOST.exec(code)![0].slice(0, 60)}) — في الإنتاج يشير إلى الخادم نفسِه أو لا شيء؛ استعمل مساراً نسبيّاً أو متغيّرَ بيئة` })
  }
  // تكرارُ الملفّ الواحد في المتغيّر نفسِه يُطوى: سطرٌ لكلّ (فحص، ملفّ، تفصيل).
  const seen = new Set<string>()
  const unique = out.filter((f) => { const k = `${f.check}|${f.file}|${f.detail}`; if (seen.has(k)) return false; seen.add(k); return true })
  if (serverEnv.size > 0) {
    if (envExample === undefined) unique.push({ check: "env-example", severity: "warn", file: ".env.example", detail: `غائب — الشيفرةُ تقرأ ${serverEnv.size} متغيّراً (${[...serverEnv].slice(0, 6).join("، ")}): انسخها أسماءً بلا قيم كي يُنشر المشروعُ على خادمٍ جديد` })
    else {
      const declared = new Set([...envExample.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gmu)].map((m) => m[1]!))
      const missing = [...serverEnv].filter((v) => !declared.has(v))
      if (missing.length > 0) unique.push({ check: "env-example", severity: "warn", file: ".env.example", detail: `ينقصه ما تقرؤه الشيفرة: ${missing.slice(0, 8).join("، ")}${missing.length > 8 ? ` و${missing.length - 8} أخرى` : ""}` })
    }
  }
  return unique
}

/** الفحوصُ على المشروع: ملفّاتُ المصدر و.env.example من جذره. */
export function codeChecks(projectDir: string): CodeFinding[] {
  const files = sourceFiles(projectDir).map((path) => { let text = ""; try { text = readFileSync(path, "utf-8") } catch { /* يُتجاوز */ } return { path, text } })
  const examplePath = join(projectDir, ".env.example")
  const example = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : undefined
  return checkSources(projectDir, files, example)
}

/** سطرُ مرحلةٍ لـrelease-check: الأخطاءُ تُسقط، والتحذيراتُ تُسمّى ولا تُسقط. */
export function renderCodeChecks(findings: readonly CodeFinding[]): { readonly ok: boolean; readonly warn: boolean; readonly detail: string } {
  const errors = findings.filter((f) => f.severity === "error")
  if (findings.length === 0) return { ok: true, warn: false, detail: "تحقّقُ المدخلات والمصادقة وبيئةُ العميل و.env.example وبلا localhost — سليم" }
  const lines = [...errors, ...findings.filter((f) => f.severity === "warn")].slice(0, 12).map((f) => `${f.severity === "error" ? "✕" : "△"} ${f.check} ${f.file}: ${f.detail}`)
  return { ok: errors.length === 0, warn: errors.length === 0, detail: `${errors.length} خطأ · ${findings.length - errors.length} تحذير\n${lines.join("\n")}${findings.length > 12 ? `\n… و${findings.length - 12} أخرى` : ""}` }
}
