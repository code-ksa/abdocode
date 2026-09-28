/**
 * `read ملف.pdf` نصٌّ لا بايتات (2026-09-28): ملفُّ PDF حقيقيٌّ يُبنى هنا بصفحتين، ويُقرأ بالوحدة وعبر exec على المحرّك الحقيقيّ.
 * والتوائم: المقطعُ صفحاتٌ (الثانيةُ وحدها لا تحمل الأولى)، وأداةٌ غائبة رفضٌ يسمّي الطريق لا ثنائيٌّ يُمرَّر.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pdftotextBinary, readPdf } from "../src/pdf-read"
import { stripChildEnv } from "../../tools/src/env-strip"

/** PDF صغيرٌ صحيحُ الجدول: صفحةٌ لكلّ نصّ، بخطّ Helvetica القياسيّ. */
function makePdf(pages: readonly string[]): Buffer {
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 3 + i * 2)
  const fontId = 3 + pages.length * 2
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) { offsets[id] = out.length; out += `${id} 0 obj\n${objects[id]}\nendobj\n` }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

const available = pdftotextBinary() !== undefined

test.skipIf(!available)("unit: every page's text with its heading, and a page range reads only those pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-pdf-"))
  try {
    const file = join(dir, "doc.pdf")
    writeFileSync(file, makePdf(["FIRST-PAGE-4411", "SECOND-PAGE-5522"]))
    const all = readPdf(file)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.text).toContain("📄 PDF: 2 صفحة")
    expect(all.text).toContain("── صفحة 1 ──")
    expect(all.text).toContain("FIRST-PAGE-4411")
    expect(all.text).toContain("SECOND-PAGE-5522")
    const second = readPdf(file, { from: 2, to: 2 })
    expect(second.ok && second.text).toContain("── صفحة 2 ──")
    expect(second.ok && second.text).toContain("SECOND-PAGE-5522")
    expect(second.ok && second.text).not.toContain("FIRST-PAGE-4411")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the twin: no pdftotext is a refusal that names the way, not bytes passed through", () => {
  let spawned = false
  const r = readPdf("x.pdf", undefined, { binary: "", spawn: () => { spawned = true; return { exitCode: 0, stdout: "%PDF-1.4 bytes", stderr: "" } } })
  expect(r.ok).toBe(false)
  expect(!r.ok && r.error).toContain("pdftotext")
  expect(spawned).toBe(false)
  // متغيّرٌ صريحٌ لمسارٍ غير موجود لا يسقط إلى PATH: الغيابُ المعلن غياب.
  expect(pdftotextBinary({ ABDO_PDFTOTEXT: join(tmpdir(), "no-such-pdftotext.exe") })).toBeUndefined()
})

test.skipIf(!available)("live: the agent's read of a PDF in the project reaches the model as text", async () => {
  const seen: string[] = []
  const replies = ["نفّذ: read report.pdf", "done."]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(seen.length, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean; messages?: unknown[] }
    seen.push(JSON.stringify(payload.messages ?? []))
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-pdf-live-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "report.pdf"), makePdf(["QUARTERLY-REVENUE-9931"]))
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "read-only", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "Summarize report.pdf", "--json", "--quiet", "--project", project, "--mode", "read-only"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2" },
    stdout: "pipe", stderr: "pipe",
  })
  const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
  const all = seen.join("\n")
  expect(all, stderr.slice(-600)).toContain("QUARTERLY-REVENUE-9931")
  expect(all).toContain("📄 PDF: 1 صفحة")
  expect(all).not.toContain("%PDF-1.4")
}, 150_000)
