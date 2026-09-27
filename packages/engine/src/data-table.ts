/**
 * تحليلُ البيانات — الفجوة #12 في جدول 2026-09-27 (ChatGPT يحسب على الملفّ المرفوع بدل أن يخمّن من نصّه).
 *
 * النموذجُ الذي يقرأ جدولاً في سياقه **يحسب في رأسه** — والمجموعُ والمتوسّطُ هناك تخمينٌ بثقة. أداةُ `table` تحسب بالكود
 * (PHILOSOPHY: الكودُ الحتميّ قبل النموذج): ملفُّ CSV/TSV/JSON في المشروع، أو مرفقٌ باسمه (`@اسم`)، ⇦ ملفٌّ تعريفيّ
 * (صفوف، أعمدة، أنواع، فراغ، إحصاءات، أكثرُ القيم) أو تجميعٌ (`--group`، `--sum|--avg|--count|--min|--max|--median`، `--where`).
 * الوحدةُ نقيّة: نصٌّ يدخل ونصٌّ يخرج.
 */

export interface Table { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly format: "csv" | "tsv" | "json" }

const ARABIC_DIGITS = /[٠-٩۰-۹]/gu
const digit = (c: string): string => String((c.codePointAt(0)! - (c >= "۰" ? 0x6f0 : 0x660)))

/** رقمٌ من خانةٍ بصيغها الشائعة: أرقامٌ عربيّة، فاصلُ آلافٍ (, أو ٬)، فاصلةٌ عشريّة ٫، نسبة %، رمزُ عملةٍ ملاصق. */
export function numberOf(raw: string): number | undefined {
  let s = raw.trim().replace(ARABIC_DIGITS, digit).replace(/٫/gu, ".").replace(/٬/gu, ",")
  s = s.replace(/^(?:SAR|USD|EUR|ر\.س|﷼|\$|€)\s*/iu, "").replace(/\s*(?:SAR|USD|EUR|ر\.س|﷼|%)$/iu, "")
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(s)) s = s.replace(/,/gu, "")
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(s)) return undefined
  const value = Number(s)
  return Number.isFinite(value) ? value : undefined
}

const splitCsvLine = (line: string, delimiter: string): string[] => {
  const out: string[] = []
  let field = "", quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!
    if (quoted) {
      if (c === "\"" && line[i + 1] === "\"") { field += "\""; i += 1 }
      else if (c === "\"") quoted = false
      else field += c
    } else if (c === "\"" && field.length === 0) quoted = true
    else if (c === delimiter) { out.push(field); field = "" }
    else field += c
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/** يقرأ الجدول: JSON (قائمةُ كائنات)، أو TSV، أو CSV بفاصلٍ يُستنتج من السطر الأوّل (, أو ;). الأسطرُ المقتبسة المتعدّدة تُجمع. */
export function parseTable(text: string, hint?: Table["format"]): Table {
  const body = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim()
  if (hint === "json" || (hint === undefined && body.startsWith("["))) {
    const data = JSON.parse(body) as unknown
    if (!Array.isArray(data) || data.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) throw new Error("JSON: المتوقّع قائمةُ كائنات")
    const columns = [...new Set(data.flatMap((row) => Object.keys(row as object)))]
    return { columns, rows: data.map((row) => columns.map((c) => { const v = (row as Record<string, unknown>)[c]; return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) })), format: "json" }
  }
  const physical = body.split("\n")
  const records: string[] = []
  for (const line of physical) {
    const last = records.at(-1)
    if (last !== undefined && ((last.match(/"/gu) ?? []).length % 2 === 1)) records[records.length - 1] = `${last}\n${line}`
    else records.push(line)
  }
  const header = records[0] ?? ""
  const format: Table["format"] = hint ?? (header.includes("\t") ? "tsv" : "csv")
  const delimiter = format === "tsv" ? "\t" : (header.split(";").length > header.split(",").length ? ";" : ",")
  const columns = splitCsvLine(header, delimiter).map((c, i) => c.length > 0 ? c : `عمود${i + 1}`)
  const rows = records.slice(1).filter((r) => r.trim().length > 0).map((r) => { const cells = splitCsvLine(r, delimiter); return columns.map((_, i) => cells[i] ?? "") })
  if (columns.length === 0) throw new Error("الجدولُ بلا أعمدة")
  return { columns, rows, format }
}

const fmt = (n: number): string => Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 4 })
const median = (values: readonly number[]): number => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

export function columnKind(values: readonly string[]): "رقم" | "تاريخ" | "نص" {
  const filled = values.filter((v) => v.trim().length > 0)
  if (filled.length === 0) return "نص"
  // عمودٌ رقميٌّ فيه «n/a» أو خاناتٌ ناقصة يبقى رقميّاً (مقيس في الاختبار: 4 من 5 كان يُصنَّف نصّاً) — وما ليس رقماً يُعدّ ويُقال.
  if (filled.filter((v) => numberOf(v) !== undefined).length >= filled.length * 0.8) return "رقم"
  if (filled.every((v) => /^\d{4}-\d{2}-\d{2}/u.test(v.trim()))) return "تاريخ"
  return "نص"
}

/** الملفُّ التعريفيّ: ما يحتاجه النموذجُ ليسأل السؤالَ الصحيح — ويُجيب بأرقامٍ محسوبة. */
export function profileTable(name: string, table: Table): string {
  const lines = [`📊 جدول «${name}»: ${fmt(table.rows.length)} صفّاً × ${table.columns.length} عموداً (${table.format})`]
  table.columns.forEach((column, i) => {
    const values = table.rows.map((r) => r[i] ?? "")
    const empty = values.filter((v) => v.trim().length === 0).length
    const kind = columnKind(values)
    if (kind === "رقم") {
      const nums = values.map(numberOf).filter((n): n is number => n !== undefined)
      const sum = nums.reduce((a, b) => a + b, 0)
      const notNumeric = values.length - empty - nums.length
      lines.push(`- «${column}» (رقم): فارغ ${empty}${notNumeric > 0 ? ` · غيرُ رقميّ ${notNumeric}` : ""} · أدنى ${fmt(Math.min(...nums))} · أعلى ${fmt(Math.max(...nums))} · متوسّط ${fmt(sum / nums.length)} · وسيط ${fmt(median(nums))} · مجموع ${fmt(sum)}`)
    } else {
      const counts = new Map<string, number>()
      for (const v of values) if (v.trim().length > 0) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1)
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v.slice(0, 40)} (${n})`).join("، ")
      lines.push(`- «${column}» (${kind}): فارغ ${empty} · قيمٌ مميّزة ${counts.size}${top.length > 0 ? ` · الأكثر: ${top}` : ""}`)
    }
  })
  const sample = table.rows.slice(0, 3).map((r) => `| ${r.map((c) => c.slice(0, 30)).join(" | ")} |`)
  if (sample.length > 0) lines.push(`أوّلُ ${sample.length} صفوف:\n| ${table.columns.join(" | ")} |\n${sample.join("\n")}`)
  lines.push("الأرقامُ محسوبةٌ بالكود لا بالنموذج — انقلها كما هي، وللتجميع: table <المصدر> --group <عمود> --sum <عمود>")
  return lines.join("\n")
}

export type AggregateOp = "sum" | "avg" | "count" | "min" | "max" | "median"
export interface Condition { readonly column: string; readonly op: "=" | "!=" | ">" | "<" | ">=" | "<="; readonly value: string }
export interface TableQuery { readonly group?: string; readonly op?: AggregateOp; readonly column?: string; readonly where: readonly Condition[]; readonly sort: "asc" | "desc"; readonly limit: number }

const indexOf = (table: Table, column: string): number => {
  const i = table.columns.findIndex((c) => c.toLowerCase() === column.toLowerCase())
  if (i < 0) throw new Error(`لا عمودَ «${column}» — الأعمدة: ${table.columns.join("، ")}`)
  return i
}

const matches = (cell: string, condition: Condition): boolean => {
  const a = numberOf(cell), b = numberOf(condition.value)
  if (condition.op === "=" || condition.op === "!=") {
    const equal = a !== undefined && b !== undefined ? a === b : cell.trim().toLowerCase() === condition.value.trim().toLowerCase()
    return condition.op === "=" ? equal : !equal
  }
  if (a === undefined || b === undefined) return false
  return condition.op === ">" ? a > b : condition.op === "<" ? a < b : condition.op === ">=" ? a >= b : a <= b
}

/** تجميعٌ حتميّ: تصفيةٌ ثمّ مجموعاتٌ ثمّ عمليّة؛ ويُقال كم صفّاً دخل الحساب وكم خانةً غيرَ رقميّة تُركت. */
export function queryTable(name: string, table: Table, query: TableQuery): string {
  const filters = query.where.map((c) => ({ c, i: indexOf(table, c.column) }))
  const rows = table.rows.filter((r) => filters.every(({ c, i }) => matches(r[i] ?? "", c)))
  const op = query.op ?? "count"
  const valueIndex = op === "count" ? undefined : indexOf(table, query.column ?? "")
  const groupIndex = query.group === undefined ? undefined : indexOf(table, query.group)
  const groups = new Map<string, string[][]>()
  for (const row of rows) { const key = groupIndex === undefined ? "الكلّ" : (row[groupIndex] ?? "").trim() || "(فارغ)"; groups.set(key, [...(groups.get(key) ?? []), [...row]]) }
  let skipped = 0
  const result = [...groups].map(([key, members]) => {
    if (valueIndex === undefined) return { key, value: members.length }
    const nums = members.map((r) => numberOf(r[valueIndex] ?? "")).filter((n): n is number => n !== undefined)
    skipped += members.length - nums.length
    const value = nums.length === 0 ? Number.NaN : op === "sum" ? nums.reduce((a, b) => a + b, 0) : op === "avg" ? nums.reduce((a, b) => a + b, 0) / nums.length
      : op === "min" ? Math.min(...nums) : op === "max" ? Math.max(...nums) : median(nums)
    return { key, value }
  }).sort((a, b) => (query.sort === "asc" ? 1 : -1) * ((Number.isNaN(a.value) ? -Infinity : a.value) - (Number.isNaN(b.value) ? -Infinity : b.value)))
  const label = op === "count" ? "العدد" : `${({ sum: "مجموع", avg: "متوسّط", min: "أدنى", max: "أعلى", median: "وسيط" } as const)[op]} «${table.columns[valueIndex!]}»`
  const head = `📊 «${name}»: ${fmt(rows.length)} من ${fmt(table.rows.length)} صفّاً بعد التصفية${query.where.length > 0 ? ` (${query.where.map((c) => `${c.column}${c.op}${c.value}`).join(" و")})` : ""}${skipped > 0 ? ` · تُركت ${skipped} خانةً غيرَ رقميّة` : ""}`
  const shown = result.slice(0, query.limit)
  const table2 = `| ${groupIndex === undefined ? "" : `${table.columns[groupIndex]} | `}${label} |\n${shown.map((r) => `| ${groupIndex === undefined ? "" : `${r.key} | `}${Number.isNaN(r.value) ? "—" : fmt(r.value)} |`).join("\n")}`
  return `${head}\n${table2}${result.length > shown.length ? `\n… و${result.length - shown.length} مجموعاتٍ أخرى (--limit)` : ""}\nمحسوبٌ بالكود — انقل الأرقامَ كما هي.`
}

const tokens = (text: string): string[] => [...text.matchAll(/"([^"]*)"|(\S+)/gu)].map((m) => m[1] ?? m[2]!)

/** `table <مصدر> [--group ع] [--sum|--avg|--min|--max|--median ع | --count] [--where ع=ق]… [--sort asc|desc] [--limit ن] [--format csv|tsv|json]` */
export function parseTableCommand(rest: string): { readonly source: string; readonly query?: TableQuery; readonly format?: Table["format"] } {
  const parts = tokens(rest)
  const source = parts.shift()
  if (source === undefined) throw new Error("الصيغة: table <ملفّ|@مرفق> [--group عمود] [--sum|--avg|--min|--max|--median عمود | --count] [--where عمود=قيمة] [--sort asc|desc] [--limit ن]")
  let group: string | undefined, op: AggregateOp | undefined, column: string | undefined, sort: "asc" | "desc" = "desc", limit = 20, format: Table["format"] | undefined
  const where: Condition[] = []
  let aggregate = false
  while (parts.length > 0) {
    const flag = parts.shift()!
    const need = (): string => { const v = parts.shift(); if (v === undefined) throw new Error(`${flag} يحتاج قيمة`); return v }
    if (flag === "--group") { group = need(); aggregate = true }
    else if (["--sum", "--avg", "--min", "--max", "--median"].includes(flag)) { op = flag.slice(2) as AggregateOp; column = need(); aggregate = true }
    else if (flag === "--count") { op = "count"; aggregate = true }
    else if (flag === "--where") {
      const m = /^(.+?)(>=|<=|!=|=|>|<)(.*)$/u.exec(need())
      if (m === null) throw new Error("--where: عمود=قيمة أو عمود>قيمة")
      where.push({ column: m[1]!.trim(), op: m[2] as Condition["op"], value: m[3]!.trim() }); aggregate = true
    } else if (flag === "--sort") { const v = need(); if (v !== "asc" && v !== "desc") throw new Error("--sort: asc أو desc"); sort = v }
    else if (flag === "--limit") { const v = Number(need()); if (!Number.isInteger(v) || v < 1 || v > 500) throw new Error("--limit بين 1 و500"); limit = v }
    else if (flag === "--format") { const v = need(); if (v !== "csv" && v !== "tsv" && v !== "json") throw new Error("--format: csv أو tsv أو json"); format = v }
    else throw new Error(`خيارٌ غيرُ معروف «${flag.slice(0, 30)}»`)
  }
  return { source, ...(aggregate ? { query: { ...(group === undefined ? {} : { group }), ...(op === undefined ? {} : { op }), ...(column === undefined ? {} : { column }), where, sort, limit } } : {}), ...(format === undefined ? {} : { format }) }
}

/** مرفقٌ باسمه من نصّ المرفقات الذي يصل الدور (`<attached-document name="…">`). */
export function attachmentText(attachmentsText: string, name: string): string | undefined {
  for (const m of attachmentsText.matchAll(/<attached-document name=("(?:[^"\\]|\\.)*")>\n([\s\S]*?)\n<\/attached-document>/gu)) {
    let docName: string
    try { docName = JSON.parse(m[1]!) as string } catch { continue }
    if (docName.toLowerCase() === name.toLowerCase()) return m[2]!
  }
  return undefined
}
