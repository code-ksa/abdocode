/**
 * خادمُ MCP لجِت — **مستودعٌ آخر، قراءةً فقط**.
 *
 * ═══ لماذا ليس ازدواجاً ═══
 *
 * عندنا أداةُ `git` أصليّة، وهي تقرأ **مشروعَك الجاري** وحده. وهذا يقرأ
 * **مستودعاً آخر** يختاره المشغّل عند التوصيل: مرجعٌ تنسخ منه، أو مستودعُ
 * عميلٍ تقارن به، أو تاريخٌ تبحث فيه وأنت تعمل في غيره. الفارقُ في الهدف لا في
 * الأمر — ولولاه لما بُني (الازدواجُ أغلى صنفِ عيبٍ في هذا المستودع).
 *
 * ═══ الأبوابُ الخلفيّةُ في «قراءةِ» مستودعٍ غريب ═══
 *
 * قراءةُ مستودعٍ لا تملكه ليست فعلاً بريئاً: **إعدادُ المستودع نفسِه يستطيع
 * تشغيل برامج**. `diff.external` يستبدل مُقارِنَ جِت ببرنامجك، و`core.pager`
 * يمرّر الخرجَ إلى أمر، و`core.fsmonitor` يشغّل مراقباً، و`credential.helper`
 * يُستدعى عند الشبكة. فيُحيَّد كلُّ ذلك بـ`-c` صريحة، ويُقطع إعدادا النظام
 * والمستخدم (`GIT_CONFIG_NOSYSTEM` و`GIT_CONFIG_GLOBAL` إلى العدم) — فلا يقرّر
 * سلوكَنا إعدادٌ لم نكتبه.
 *
 * والأسماءُ المستعارة لا تُظلّل أمراً مدمجاً في جِت، فـ`log` و`show` تبقى
 * نفسَها — ومع ذلك تُقطع الإعداداتُ لأنّ الاعتمادَ على تلك القاعدة وحدها رهان.
 *
 * وثلاثةٌ أخرى: **قائمةٌ مغلقةٌ من الأوامر** (لا `fetch` ولا `push` ولا `clone`
 * ولا `config`)، و**لا صدفةَ أبداً** (argv مباشرةً، فلا يُفسَّر حرفٌ)، و**كلُّ
 * وسيطٍ يبدأ بشرطةٍ يُرفض** — وإلّا صار مرجعٌ اسمُه `--upload-pack=…` خياراً.
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { stripChildEnv } from "@abdo/tools/env-strip"

export const GIT_MCP_PROTOCOL = "2025-11-25"
export const MAX_TEXT = 8_000
export const MAX_COMMITS = 100

/**
 * إعداداتٌ تُحيَّد عند كلّ نداء — كلُّ واحدةٍ منها تشغّل برنامجاً لو تُركت
 * لإعداد المستودع الغريب.
 */
export const NEUTRALISED_CONFIG: readonly string[] = Object.freeze([
  "core.pager=cat",
  "core.fsmonitor=",
  "core.hooksPath=/dev/null",
  "diff.external=",
  "credential.helper=",
  "protocol.ext.allow=never",
  "uploadpack.packObjectsHook=",
])

/** بيئةٌ لا تحمل سرّاً ولا تقرأ إعدادَ نظامٍ أو مستخدم. */
export const gitEnv = (source: Readonly<Record<string, string | undefined>>): Record<string, string> => ({
  ...stripChildEnv(source).env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
})

/**
 * وسيطٌ يبدأ بشرطةٍ خيارٌ لا قيمة. مرجعٌ اسمُه `--upload-pack=x` يصير أمراً،
 * وهي أشهرُ حِيَل حقن الخيارات في أدوات سطر الأمر.
 */
export const safeArgument = (value: string, what: string): { readonly ok: true } | { readonly ok: false; readonly why: string } => {
  if (value.length === 0) return { ok: false, why: `${what} فارغ` }
  if (value.length > 400) return { ok: false, why: `${what} أطولُ من 400 محرف` }
  if (value.startsWith("-")) return { ok: false, why: `${what} يبدأ بشرطة — يُقرأ خياراً لا قيمة` }
  // نقطتان متتاليتان في مسار: خروجٌ من المستودع. وجِت يرفضها أيضاً، والحاجزان
  // أفضل من واحد.
  if (value.includes("..") && what.includes("مسار")) return { ok: false, why: `${what} يحوي «..»` }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return { ok: false, why: `${what} يحوي محرفَ تحكّم` }
  return { ok: true }
}

/** الأوامرُ المسموحة — **مغلقةٌ بالاسم**، ولا شبكةَ فيها ولا كتابة. */
export const READ_COMMANDS: readonly string[] = Object.freeze(["log", "show", "diff", "branch", "status", "cat-file", "rev-parse"])

export interface GitOutcome {
  readonly ok: boolean
  readonly text: string
}

const cap = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… وقُطع النصُّ عند سقف ${MAX_TEXT} محرفاً` : text

/** يشغّل جِت على المستودع المربوط. بلا صدفةٍ، وبإعدادٍ محيَّد. */
export const runGit = async (repo: string, args: readonly string[]): Promise<GitOutcome> => {
  if (!READ_COMMANDS.includes(args[0] ?? "")) return { ok: false, text: `أمرٌ غيرُ مسموح: ${String(args[0]).slice(0, 32)}` }
  const argv = ["git", "-C", repo, "--no-pager"]
  for (const setting of NEUTRALISED_CONFIG) argv.push("-c", setting)
  argv.push(...args)
  const child = Bun.spawn(argv, { env: gitEnv(process.env), stdout: "pipe", stderr: "pipe" })
  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()
  const code = await child.exited
  if (code !== 0) return { ok: false, text: cap(err.trim().length > 0 ? err : `جِت خرج بالرمز ${code}`) }
  return { ok: true, text: cap(out.trimEnd().length === 0 ? "(بلا مخرَج)" : out.trimEnd()) }
}

const TOOLS = Object.freeze([
  Object.freeze({
    name: "log",
    description: "آخرُ الإيداعات: التجزئةُ والكاتبُ والتاريخُ والعنوان.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "عددُ الإيداعات (حتى 100)" },
        ref: { type: "string", description: "فرعٌ أو مرجع" },
      },
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "show",
    description: "إيداعٌ بعينه: رسالتُه وإحصاءُ ملفّاته.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "مرجعُ الإيداع" } },
      required: ["ref"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "diff",
    description: "فرقٌ بين مرجعين، أو إحصاءُ فرقٍ لمرجعٍ واحد.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "المرجعُ الأوّل" },
        to: { type: "string", description: "المرجعُ الثاني" },
      },
      required: ["from"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "file",
    description: "محتوى ملفٍّ عند مرجعٍ بعينه.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "المرجع" },
        path: { type: "string", description: "مسارٌ داخل المستودع" },
      },
      required: ["ref", "path"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "branches",
    description: "الفروعُ المحلّيّةُ وآخرُ إيداعٍ لكلٍّ منها.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }),
])

/** يترجم أداةً إلى وسائطِ جِت. مفصولٌ ليُقاس بلا مستودعٍ حيّ. */
export const gitArgsFor = (
  name: string,
  args: Record<string, unknown>,
): { readonly ok: true; readonly args: readonly string[] } | { readonly ok: false; readonly why: string } => {
  const ref = typeof args.ref === "string" ? args.ref : undefined
  if (name === "log") {
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.trunc(args.limit), 1), MAX_COMMITS)
      : 20
    if (ref !== undefined) {
      const verdict = safeArgument(ref, "المرجع")
      if (!verdict.ok) return { ok: false, why: verdict.why }
    }
    return { ok: true, args: ["log", `-${limit}`, "--date=short", "--format=%h %ad %an — %s", ...(ref === undefined ? [] : [ref])] }
  }
  if (name === "show") {
    if (ref === undefined) return { ok: false, why: "show يحتاج مرجعاً" }
    const verdict = safeArgument(ref, "المرجع")
    if (!verdict.ok) return { ok: false, why: verdict.why }
    // ‏`--no-textconv`: مُحوِّلُ النصّ في `.gitattributes` **يشغّل برنامجاً**
    // ولا يسدّه `-c` لأنّه يُسمّى بسائقٍ من المستودع. قِيس أنّه يُنفَّذ فعلاً.
    return { ok: true, args: ["show", "--no-textconv", "--stat", "--format=%H%n%an <%ae>%n%ad%n%n%B", ref] }
  }
  if (name === "diff") {
    const from = typeof args.from === "string" ? args.from : undefined
    const to = typeof args.to === "string" ? args.to : undefined
    if (from === undefined) return { ok: false, why: "diff يحتاج from" }
    for (const [value, label] of [[from, "المرجع الأوّل"], [to ?? "HEAD", "المرجع الثاني"]] as const) {
      const verdict = safeArgument(value, label)
      if (!verdict.ok) return { ok: false, why: verdict.why }
    }
    const base = ["diff", "--no-textconv", "--stat"]
    return { ok: true, args: to === undefined ? [...base, from] : [...base, from, to] }
  }
  if (name === "file") {
    const path = typeof args.path === "string" ? args.path : undefined
    if (ref === undefined || path === undefined) return { ok: false, why: "file يحتاج ref وpath" }
    for (const [value, label] of [[ref, "المرجع"], [path, "مسار الملفّ"]] as const) {
      const verdict = safeArgument(value, label)
      if (!verdict.ok) return { ok: false, why: verdict.why }
    }
    // ‏`--` تفصل المراجعَ عن المسارات: بدونها يلتبس ملفٌّ اسمُه اسمُ فرع.
    return { ok: true, args: ["show", `${ref}:${path}`] }
  }
  if (name === "branches") return { ok: true, args: ["branch", "--format=%(refname:short) %(objectname:short) %(contents:subject)"] }
  return { ok: false, why: `أداةٌ مجهولة: ${name.slice(0, 48)}` }
}

type RpcId = string | number | null
const write = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const ok = (id: RpcId, result: unknown): void => write({ jsonrpc: "2.0", id, result })
const fail = (id: RpcId, code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message } })

/** يشغّل الخادم على stdio. المستودعُ من سطر الأمر — لا أداةَ تفتح غيرَه. */
export const serveGitMcp = async (repoPath: string): Promise<number> => {
  const repo = resolve(repoPath)
  if (!existsSync(join(repo, ".git")) && !existsSync(join(repo, "HEAD"))) {
    process.stderr.write(`ليس مستودعَ جِت: ${repo}\n`)
    return 2
  }
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let cut: number
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (line.trim().length === 0) continue
      let request: { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }
      try { request = JSON.parse(line) } catch { continue }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") continue
      if (request.id === undefined || request.id === null) continue
      const id = request.id
      if (request.method === "initialize") {
        const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        ok(id, {
          protocolVersion: typeof asked === "string" ? asked : GIT_MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "abdocode-git", version: "1" },
        })
        continue
      }
      if (request.method === "ping") { ok(id, {}); continue }
      if (request.method === "tools/list") { ok(id, { tools: TOOLS }); continue }
      if (request.method !== "tools/call") { fail(id, -32601, "Method not found"); continue }
      const name = (request.params as { name?: unknown } | undefined)?.name
      const args = (request.params as { arguments?: unknown } | undefined)?.arguments
      if (typeof name !== "string") { fail(id, -32602, "tools/call يحتاج name"); continue }
      const planned = gitArgsFor(name, (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>)
      if (!planned.ok) { ok(id, { isError: true, content: [{ type: "text", text: planned.why }] }); continue }
      const outcome = await runGit(repo, planned.args)
      ok(id, outcome.ok
        ? { content: [{ type: "text", text: outcome.text }] }
        : { isError: true, content: [{ type: "text", text: outcome.text }] })
    }
  }
  return 0
}

export * as GitMcp from "./git"
