/**
 * الفجوة #12 (2026-09-27) — أداةُ table: الأرقامُ بالكود. الصيغُ الشائعة تُقرأ، وما ليس رقماً لا يُحسب رقماً،
 * والمحرّكُ الحقيقيّ يعيد للنموذج مجموعاتٍ محسوبة بدل أن يجمع في رأسه.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { attachmentText, numberOf, parseTable, parseTableCommand, profileTable, queryTable } from "../src/data-table"
import { stripChildEnv } from "../../tools/src/env-strip"

const SALES = [
  "city,product,amount,note",
  "الرياض,قهوة,\"1,200\",عادي",
  "جدة,شاي,300,\"سطرٌ فيه, فاصلة\"",
  "الرياض,شاي,٤٥٠,",
  "الدمام,قهوة,SAR 50,\"متعدّد",
  "الأسطر\"",
  "جدة,قهوة,n/a,مفقود",
].join("\n")

test("numbers in their common shapes are read; what is not a number is not counted as one", () => {
  expect(numberOf("1,200")).toBe(1200)
  expect(numberOf("١٢٣٫٥")).toBe(123.5)
  expect(numberOf("SAR 1,000")).toBe(1000)
  expect(numberOf("15%")).toBe(15)
  expect(numberOf("-3.5e2")).toBe(-350)
  for (const text of ["n/a", "", "1,23", "12abc", "1.2.3", "٤٥ ٠"]) expect(numberOf(text), text).toBeUndefined()
})

test("CSV with quotes, embedded commas and a multi-line field; semicolons, TSV and JSON", () => {
  const table = parseTable(SALES)
  expect(table.columns).toEqual(["city", "product", "amount", "note"])
  expect(table.rows).toHaveLength(5)
  expect(table.rows[1]![3]).toBe("سطرٌ فيه, فاصلة")
  expect(table.rows[3]![3]).toBe("متعدّد\nالأسطر")
  expect(parseTable("a;b\n1;2").rows).toEqual([["1", "2"]])
  expect(parseTable("a\tb\n1\t2").format).toBe("tsv")
  expect(parseTable('[{"a":1,"b":{"x":1}},{"a":2}]')).toEqual({ columns: ["a", "b"], rows: [["1", '{"x":1}'], ["2", ""]], format: "json" })
})

test("profile and aggregates are exact, and the rows left out of a sum are said", () => {
  const table = parseTable(SALES)
  const profile = profileTable("sales.csv", table)
  expect(profile).toContain("📊 جدول «sales.csv»: 5 صفّاً × 4 عموداً (csv)")
  expect(profile).toContain("«amount» (رقم): فارغ 0 · غيرُ رقميّ 1 · أدنى 50 · أعلى 1,200 · متوسّط 500 · وسيط 375 · مجموع 2,000")
  expect(profile).toContain("«city» (نص): فارغ 0 · قيمٌ مميّزة 3 · الأكثر: الرياض (2)، جدة (2)، الدمام (1)")
  const byCity = queryTable("sales.csv", table, { group: "city", op: "sum", column: "amount", where: [], sort: "desc", limit: 20 })
  expect(byCity).toContain("| الرياض | 1,650 |")
  expect(byCity).toContain("| جدة | 300 |")
  expect(byCity).toContain("| الدمام | 50 |")
  expect(byCity).toContain("تُركت 1 خانةً غيرَ رقميّة")
  expect(byCity.indexOf("الرياض")).toBeLessThan(byCity.indexOf("الدمام"))
  const coffee = queryTable("sales.csv", table, { op: "avg", column: "amount", where: [{ column: "product", op: "=", value: "قهوة" }], sort: "desc", limit: 20 })
  expect(coffee).toContain("3 من 5 صفّاً بعد التصفية (product=قهوة)")
  expect(coffee).toContain("| 625 |")
  const big = queryTable("sales.csv", table, { op: "count", where: [{ column: "amount", op: ">=", value: "300" }], sort: "desc", limit: 20 })
  expect(big).toContain("| 3 |")
  expect(() => queryTable("sales.csv", table, { op: "sum", column: "price", where: [], sort: "desc", limit: 20 })).toThrow(/لا عمودَ «price»/u)
})

test("the command line and attachments by name", () => {
  expect(parseTableCommand('sales.csv --group city --sum amount --where "product=قهوة" --limit 5')).toEqual({ source: "sales.csv", query: { group: "city", op: "sum", column: "amount", where: [{ column: "product", op: "=", value: "قهوة" }], sort: "desc", limit: 5 } })
  expect(parseTableCommand("sales.csv")).toEqual({ source: "sales.csv" })
  expect(() => parseTableCommand("sales.csv --explode")).toThrow(/خيارٌ غيرُ معروف/u)
  const text = '\n\n<attached-document name="q3.xlsx">\nregion\tsales\nnorth\t5\n</attached-document>\n\n<attached-document name="notes.txt">\nhi\n</attached-document>'
  expect(attachmentText(text, "Q3.XLSX")).toBe("region\tsales\nnorth\t5")
  expect(attachmentText(text, "missing.csv")).toBeUndefined()
})

test("on the real engine: the model asks table and receives computed sums, not its own arithmetic", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-table-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "sales.csv"), SALES)
  const replies = ["نفّذ: table sales.csv --group city --sum amount", "Riyadh leads with 1,650."]
  let n = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(n++, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "auto", turn: { id: "d1", body: "Which city has the highest total amount in sales.csv?" } })
    await wait(() => frames.some((f) => f.turnId === "d1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const result = frames.find((f) => f.turnId === "d1" && f.kind === "tool-result")
    expect(result.verdict).toMatchObject({ ok: true })
    expect(String(result.output)).toContain("| الرياض | 1,650 |")
    expect(String(result.output)).toContain("محسوبٌ بالكود")
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
