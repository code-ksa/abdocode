/**
 * عبدو كود خادمَ MCP — الفجوة #13 في جدول 2026-09-27 (Codex وClaude Code يُستدعيان من أدواتٍ أخرى كخادمَي MCP).
 *
 *   abdocode mcp-agent <مجلّد المشروع> [--mode read-only|auto|full-access]
 *
 * أداةٌ واحدة `run_task`: دورُ وكيلٍ كامل عبر `exec-mode.ts` نفسِه (المالكُ الوحيد لقيادة دورٍ بلا واجهة) — البوّاباتُ والنواةُ
 * والدفترُ كما هي، والموافقاتُ تُرفض آليّاً. **المشروعُ والنمطُ يُثبَّتان عند الإقلاع** من سطر الأمر الذي كتبه المستخدم في
 * إعداد عميله: العميلُ لا يوجّهه إلى مجلّدٍ آخر ولا يوسّع صلاحيّته. والمهامُّ تُنفَّذ واحدةً بعد واحدة، بينما يُجاب ping
 * وtools/list في الحال — طابورٌ لا حبس.
 */
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { runExec, type ExecOptions, type ExecSummary } from "../exec-mode"

export const AGENT_MCP_PROTOCOL = "2025-11-25"
const MIN_TIMEOUT = 10
const MAX_TIMEOUT = 3 * 3600

export const TOOLS = Object.freeze([
  Object.freeze({
    name: "run_task",
    description: "Run one AbdoCode agent task in the project this server was started for, and return its answer with a summary (outcome, tools used, approvals refused). Approvals are refused automatically: the permission mode is fixed when the server starts.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task, in natural language" },
        timeout_seconds: { type: "number", description: `Optional wall-clock limit, ${MIN_TIMEOUT}-${MAX_TIMEOUT} seconds (default 1800)` },
      },
      required: ["task"],
      additionalProperties: false,
    },
  }),
])

/** نصُّ النتيجة للعميل: الجوابُ ثمّ سطرُ الخلاصة — والخلاصةُ كاملةً في structuredContent. */
export function resultOf(summary: ExecSummary): { content: { type: "text"; text: string }[]; structuredContent: ExecSummary; isError?: true } {
  const line = `— ${summary.outcome}${summary.stop === undefined ? "" : ` (${summary.stop})`} · ${summary.tools.length} tools · ${Math.round(summary.durationMs / 1000)} s${summary.approvalsDenied.length > 0 ? ` · ${summary.approvalsDenied.length} approvals refused` : ""}${summary.reason === undefined ? "" : ` · ${summary.reason}`}`
  return { content: [{ type: "text", text: `${summary.answer}\n\n${line}`.trim() }], structuredContent: summary, ...(summary.exitCode === 2 ? { isError: true as const } : {}) }
}

export function parseAgentArgs(args: readonly string[]): { readonly project: string; readonly mode: ExecOptions["mode"] } | { readonly error: string } {
  const [dir, ...rest] = args
  if (dir === undefined || dir.startsWith("--")) return { error: "mcp-agent يحتاج مجلّدَ المشروع: mcp-agent <مجلّد> [--mode read-only|auto|full-access]" }
  const project = resolve(dir)
  if (!existsSync(project) || !statSync(project).isDirectory()) return { error: `ليس مجلّداً: ${project}` }
  let mode: ExecOptions["mode"] = "auto"
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== "--mode") return { error: `خيارٌ غيرُ معروف «${String(rest[i]).slice(0, 30)}»` }
    const value = rest[++i]
    if (value !== "read-only" && value !== "auto" && value !== "full-access") return { error: "--mode: read-only أو auto أو full-access" }
    mode = value
  }
  return { project, mode }
}

type RpcId = string | number | null
const write = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const ok = (id: RpcId, result: unknown): void => write({ jsonrpc: "2.0", id, result })
const fail = (id: RpcId, code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message } })

/** يشغّل الخادم على stdio. stdout لبروتوكول MCP وحده؛ التقدّمُ إلى stderr. */
export const serveAgentMcp = async (args: readonly string[], engineArgv: readonly string[], env: Record<string, string | undefined>): Promise<number> => {
  const parsed = parseAgentArgs(args)
  if ("error" in parsed) { process.stderr.write(`${parsed.error}\n`); return 2 }
  let queue: Promise<unknown> = Promise.resolve()
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
        ok(id, { protocolVersion: typeof asked === "string" ? asked : AGENT_MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "abdocode-agent", version: "1" } })
        continue
      }
      if (request.method === "ping") { ok(id, {}); continue }
      if (request.method === "tools/list") { ok(id, { tools: TOOLS }); continue }
      if (request.method !== "tools/call") { fail(id, -32601, "Method not found"); continue }
      const name = (request.params as { name?: unknown } | undefined)?.name
      const input = ((request.params as { arguments?: unknown } | undefined)?.arguments ?? {}) as { task?: unknown; timeout_seconds?: unknown }
      if (name !== "run_task") { ok(id, { isError: true, content: [{ type: "text", text: `Unknown tool: ${String(name).slice(0, 48)}` }] }); continue }
      if (typeof input.task !== "string" || input.task.trim().length === 0) { ok(id, { isError: true, content: [{ type: "text", text: "run_task needs a non-empty task" }] }); continue }
      const seconds = typeof input.timeout_seconds === "number" ? Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, input.timeout_seconds)) : 1800
      const options: ExecOptions = { task: input.task.trim(), project: parsed.project, mode: parsed.mode, timeoutMs: seconds * 1000, json: true, quiet: false }
      // طابور: مهمّةٌ بعد مهمّة على المشروع نفسِه، والحلقةُ لا تنتظرها فتبقى تجيب ping.
      queue = queue.then(async () => {
        try { ok(id, resultOf(await runExec(options, engineArgv, env, (progress) => { process.stderr.write(`${progress}\n`) }))) }
        catch (cause) { ok(id, { isError: true, content: [{ type: "text", text: `run_task failed: ${String(cause instanceof Error ? cause.message : cause).slice(0, 300)}` }] }) }
      })
    }
  }
  await queue
  return 0
}

export * as AgentMcp from "./agent"
