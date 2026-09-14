/** خادم MCP قياسي لبحث Google، عبر stdio JSON-RPC. */
import { GoogleSearch } from "./mind/google-search"
import { RustReachEffects } from "./provider-effects"
import { join, resolve } from "node:path"

const COMPILED = !/bun(\.exe)?$/i.test(process.execPath)
const ROOT = COMPILED ? join(process.execPath, "..") : import.meta.dir
const TOOL_WORKER = COMPILED ? join(ROOT, "bin", "abdo-tool-worker.exe") : resolve(ROOT, "..", "..", "kernel", "target", "release", "abdo-tool-worker.exe")
const KERNEL = COMPILED ? join(ROOT, "bin", "abdo-kernel.exe") : resolve(ROOT, "..", "..", "kernel", "target", "release", "abdo-kernel.exe")
const STATE_ROOT = resolve(process.env.ABDO_CODE_STATE_DIR ?? ROOT)
const REACH = new RustReachEffects(TOOL_WORKER, KERNEL, join(STATE_ROOT, "abdocode.sqlite"), () => process.cwd())

type RpcId = string | number | null
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }

const emit = (value: object) => console.log(JSON.stringify(value))
const result = (id: RpcId, value: unknown) => emit({ jsonrpc: "2.0", id, result: value })
const error = (id: RpcId, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } })

const tool = {
  name: "google_search",
  title: "Google Search",
  description: "بحث ويب منظّم عبر Google Programmable Search. قراءة فقط، مع SafeSearch مفعّل افتراضياً.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 300, description: "عبارة البحث" },
      count: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      site: { type: "string", description: "نطاق اختياري لحصر النتائج، مثل example.com" },
      language: { type: "string", default: "ar" },
      country: { type: "string", default: "sa" },
      safe: { type: "string", enum: ["active", "off"], default: "active" },
      kind: { type: "string", enum: ["web", "image"], default: "web", description: "image: نتائجُ صورٍ (searchType=image) ببيانات الصفحة الحاضنة والمصغَّرة والأبعاد والنوع" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}

for await (const line of console) {
  if (line.trim().length === 0) continue
  let request: RpcRequest
  try { request = JSON.parse(line) } catch { error(null, -32700, "Parse error"); continue }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    if (request.id !== undefined) error(request.id, -32600, "Invalid Request")
    continue
  }
  if (request.method === "notifications/initialized") continue
  const id = request.id ?? null
  if (request.method === "initialize") {
    const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
    result(id, {
      protocolVersion: typeof requested === "string" ? requested : "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "abdocode-google-search", version: "1.0.0" },
    })
    continue
  }
  if (request.method === "tools/list") { result(id, { tools: [tool] }); continue }
  if (request.method === "ping") { result(id, {}); continue }
  if (request.method !== "tools/call") { error(id, -32601, "Method not found"); continue }
  const name = request.params?.name
  const args = request.params?.arguments as Record<string, unknown> | undefined
  if (name !== tool.name || typeof args?.query !== "string") { error(id, -32602, "Invalid tool arguments"); continue }
  try {
    const input = GoogleSearch.normaliseRequest({
      query: args.query,
      count: typeof args.count === "number" ? args.count : undefined,
      site: typeof args.site === "string" ? args.site : undefined,
      language: typeof args.language === "string" ? args.language : undefined,
      country: typeof args.country === "string" ? args.country : undefined,
      safe: args.safe === "off" ? "off" : "active",
      kind: args.kind === "image" ? "image" : "web",
    })
    const response = await REACH.googleSearch({
      query: input.query, count: input.count!, site: input.site, language: input.language!, country: input.country!, safe: input.safe!, kind: input.kind, timeoutMs: 15_000,
    })
    const found = GoogleSearch.decodeWorkerResponse(input, response.status, response.body)
    result(id, { content: [{ type: "text", text: GoogleSearch.format(found) }], structuredContent: found })
  } catch (cause) {
    result(id, { isError: true, content: [{ type: "text", text: String(cause instanceof Error ? cause.message : cause) }] })
  }
}
