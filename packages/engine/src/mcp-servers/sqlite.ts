/**
 * خادمُ MCP لقاعدة SQLite — **قراءةً فقط**، ويشحن داخل ثنائيّنا.
 *
 * الفكرةُ من خوادم MCP المرجعيّة، **والكودُ والحرّاسُ ملكنا** — القاعدةُ نفسُها
 * التي بُني عليها `mind/external.ts`. ولا حزمةَ تُنزَّل: الأمرُ فرعيٌّ في
 * `abdocode` نفسه (`abdocode mcp-sqlite <ملفّ>`)، فلا سلسلةَ توريدٍ جديدة ولا
 * `node_modules` لطرفٍ ثالث في مسارٍ ينفّذ. و`bun:sqlite` مدمجٌ في وقت التشغيل.
 *
 * والفجوةُ مقيسة: كتالوجُ الأدوات ثلاثون أداةً وليس فيه سطرُ SQL واحد. فهذا
 * خادمٌ يملأ فراغاً، لا نسخةٌ ثانيةٌ من `read` أو `run`.
 *
 * ═══ الحرّاسُ الأربعة — «بدون أبوابٍ خلفيّة» بنصّها ═══
 *
 * ١) **القراءةُ يفرضها المحرّك لا التعبيرُ النمطيّ.** الاتّصالُ يُفتح
 *    `readonly: true`، فـSQLite نفسُها ترفض كلَّ كتابة. وفحصُ شكل الجملة يبقى
 *    فوقه **ليقول سبباً مفهوماً** لا ليكون الحارس: حارسٌ نمطيٌّ وحده يُلتفّ
 *    عليه بتعليقٍ أو مسافة، والحارسُ الحقيقيُّ هو المحرّك.
 *
 * ٢) **`ATTACH` مرفوضةٌ بالاسم.** اتّصالٌ للقراءة يستطيع ضمَّ ملفٍّ آخر ويقرؤه
 *    — فيخرج من الملفّ المسموح إلى قرصِ المستخدم كلِّه. وهي البابُ الخلفيُّ
 *    الوحيدُ الذي لا يسدّه `readonly`.
 *
 * ٣) **الملفُّ من `argv` لا من النموذج.** لا أداةَ تفتح قاعدةً أخرى: الخادمُ
 *    يُوصَل بملفٍّ واحدٍ اختاره المشغّل عند التوصيل، وينتهي الأمر.
 *
 * ٤) **سقوفٌ على الخرج.** صفوفٌ ومحارف — نتيجةٌ بلا سقفٍ تملأ سياقَ النموذج
 *    وتُسقط الدور.
 *
 * وكلُّ أدواته تصل الكتالوجَ بصنف `command` كبقيّة أدوات MCP: إقرارُ خادمٍ عن
 * نفسه ليس دليلاً، ولو كان الخادمُ خادمَنا.
 */

import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import { judgeReadOnly, type SqlVerdict } from "./read-only-sql"

export const SQLITE_MCP_PROTOCOL = "2025-11-25"
export const MAX_ROWS = 200
export const MAX_TEXT = 8_000

type RpcId = string | number | null

/**
 * كلماتٌ تُرفض أينما وقعت في SQLite: تفتح ملفّاً آخر أو تحمّل شيفرة.
 *
 * ‏`ATTACH` هي **البابُ الوحيد الذي لا يسدّه `readonly`**: اتّصالُ قراءةٍ يضمّ
 * ملفّاً ثانياً فيقرأ خارج المسموح. ولهذا وحده وُجد الفحصُ الشكليّ هنا.
 */
export const SQLITE_FORBIDDEN: readonly string[] = Object.freeze(["attach", "detach", "load_extension", "vacuum into"])

/**
 * يحكم على جملةٍ لـSQLite. **ليس هذا الحارس**: الحارسُ اتّصالٌ للقراءة يفرضه
 * المحرّك؛ هذا يقول سبباً مفهوماً ويسدّ `ATTACH`.
 */
export const judgeStatement = (raw: string): SqlVerdict => judgeReadOnly(raw, SQLITE_FORBIDDEN)

/** صفوفٌ ← نصٌّ مقروء، بسقفَي الصفوف والمحارف، والقطعُ يُعلَن لا يُخفى. */
export const renderRows = (rows: readonly Record<string, unknown>[]): string => {
  if (rows.length === 0) return "(لا صفوف)"
  const shown = rows.slice(0, MAX_ROWS)
  const columns = Object.keys(shown[0]!)
  const lines = [columns.join(" | "), columns.map(() => "---").join(" | ")]
  for (const row of shown) {
    lines.push(columns.map((column) => {
      const value = row[column]
      return value === null ? "NULL" : typeof value === "object" ? "<blob>" : String(value)
    }).join(" | "))
  }
  if (rows.length > shown.length) lines.push(`… وقُطع ${rows.length - shown.length} صفّاً عند سقف ${MAX_ROWS}`)
  const text = lines.join("\n")
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… وقُطع النصُّ عند سقف ${MAX_TEXT} محرفاً` : text
}

const TOOLS = Object.freeze([
  Object.freeze({
    name: "tables",
    description: "أسماءُ الجداول والمَشاهد في القاعدة الموصولة.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }),
  Object.freeze({
    name: "schema",
    description: "نصُّ إنشاء جدولٍ أو مَشهدٍ بعينه.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "اسمُ الجدول" } },
      required: ["table"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "query",
    description: "جملةُ قراءةٍ واحدة (SELECT أو WITH أو EXPLAIN). الكتابةُ يرفضها المحرّك نفسُه.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "جملةُ SQL للقراءة" } },
      required: ["sql"],
      additionalProperties: false,
    },
  }),
])

const write = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const ok = (id: RpcId, result: unknown): void => write({ jsonrpc: "2.0", id, result })
const fail = (id: RpcId, code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message } })
const textResult = (id: RpcId, text: string): void => ok(id, { content: [{ type: "text", text }] })
const toolError = (id: RpcId, text: string): void => ok(id, { isError: true, content: [{ type: "text", text }] })

/** ينفّذ أداةً على اتّصالٍ مفتوحٍ للقراءة. مفصولٌ كي يُقاس بلا أنبوب. */
export const runTool = (database: Database, name: string, args: Record<string, unknown>): SqlVerdict & { readonly text: string } => {
  if (name === "tables") {
    const rows = database.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Record<string, unknown>[]
    return { ok: true, text: renderRows(rows) }
  }
  if (name === "schema") {
    const table = args.table
    if (typeof table !== "string" || table.length === 0) return { ok: false, text: "schema يحتاج اسمَ جدول" }
    // مُعامَلٌ مربوط: اسمٌ من النموذج لا يُلصق في جملة أبداً.
    const rows = database.query("SELECT sql FROM sqlite_master WHERE name = ?").all(table) as { sql: string | null }[]
    if (rows.length === 0) return { ok: false, text: `لا جدولَ ولا مَشهدَ باسم «${table.slice(0, 64)}»` }
    return { ok: true, text: rows.map((row) => row.sql ?? "(بلا نصّ إنشاء)").join("\n\n") }
  }
  if (name === "query") {
    const sql = args.sql
    if (typeof sql !== "string") return { ok: false, text: "query يحتاج نصَّ sql" }
    const verdict = judgeStatement(sql)
    if (!verdict.ok) return { ok: false, text: `رُفضت الجملة: ${verdict.why}` }
    try {
      return { ok: true, text: renderRows(database.query(sql).all() as Record<string, unknown>[]) }
    } catch (cause) {
      return { ok: false, text: `رفضها المحرّك: ${cause instanceof Error ? cause.message : String(cause)}` }
    }
  }
  return { ok: false, text: `أداةٌ مجهولة: ${name.slice(0, 48)}` }
}

/** يشغّل الخادم على stdio حتى يُغلق المدخل. */
export const serveSqliteMcp = async (databasePath: string): Promise<number> => {
  let database: Database
  try {
    // ⚠ الحارسُ الحقيقيّ: المحرّكُ نفسُه يرفض الكتابة. ولا `create`، فملفٌّ
    // غائبٌ يُرفض مسمّى ولا يُنشأ فارغاً فيُوهم أنّه قاعدةٌ سليمة.
    database = new Database(resolve(databasePath), { readonly: true, create: false })
  } catch (cause) {
    process.stderr.write(`تعذّر فتح القاعدة للقراءة: ${cause instanceof Error ? cause.message : String(cause)}\n`)
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
      // إشعارٌ بلا معرّف: يُستهلك ولا يُجاب — والردُّ عليه كسرٌ للبروتوكول.
      if (request.id === undefined || request.id === null) continue
      const id = request.id
      if (request.method === "initialize") {
        const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        ok(id, {
          protocolVersion: typeof asked === "string" ? asked : SQLITE_MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "abdocode-sqlite", version: "1" },
        })
        continue
      }
      if (request.method === "ping") { ok(id, {}); continue }
      if (request.method === "tools/list") { ok(id, { tools: TOOLS }); continue }
      if (request.method !== "tools/call") { fail(id, -32601, "Method not found"); continue }
      const name = (request.params as { name?: unknown } | undefined)?.name
      const args = (request.params as { arguments?: unknown } | undefined)?.arguments
      if (typeof name !== "string") { fail(id, -32602, "tools/call يحتاج name"); continue }
      const outcome = runTool(database, name, (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>)
      // فشلُ الأداة يُعلَن **داخل النتيجة** كما يقول البروتوكول، لا خطأَ نقل:
      // خطأُ النقل يعني «لم يُفهم الطلب»، وهذا طلبٌ فُهم ورُفض.
      if (outcome.ok) textResult(id, outcome.text)
      else toolError(id, outcome.text)
    }
  }
  database.close()
  return 0
}

export * as SqliteMcp from "./sqlite"
