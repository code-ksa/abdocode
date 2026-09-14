import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LspClient } from "@abdo/lsp"
import { canonicalUri, fileUri, locateServer, StdioLspTransport } from "../src/lsp-stdio"

// نقلُ LSP على stdio ضدّ خادمٍ زائف (سكربت node يتكلّم JSON-RPC بترويسة Content-Length): initialize، تشخيصاتٌ مدفوعة، تعريفٌ،
// مراجع، وموتُ الخادم يظهر «غير متاح» لا مصفوفةً فارغة. لا خادمَ لغةٍ حقيقيّ يُنزَّل.

const FAKE_SERVER = `
const chunks = []
let buf = Buffer.alloc(0)
const send = (obj) => { const body = Buffer.from(JSON.stringify(obj)); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body])) }
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const i = buf.indexOf('\\r\\n\\r\\n'); if (i < 0) break
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, i).toString())[1])
    if (buf.length < i + 4 + len) break
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString()); buf = buf.subarray(i + 4 + len)
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true } } })
    // الخادمُ يعيد URI بترميزه (حرفُ سواقةٍ صغير و":" مرمَّزة) كما يفعل typescript-language-server، وشدّاتٍ 1..4 وواحدةً بلا شدّة
    else if (msg.method === 'textDocument/didOpen') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri.replace(/^file:\\/\\/\\/([A-Za-z]):/, (m, d) => 'file:///' + d.toLowerCase() + '%3A'), diagnostics: [1, 2, 3, 4, undefined].map((severity, i) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } }, severity, message: i === 0 ? 'Type boom' : 'd' + i })) } })
    else if (msg.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } }] })
    else if (msg.method === 'textDocument/references') send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///x/a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }, { uri: 'file:///x/b.ts', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } }] })
    else if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null })
    else if (msg.method === 'exit' || msg.method === 'die') process.exit(3)
    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
  }
})
`

describe("StdioLspTransport", () => {
  test("initialize، تشخيصاتٌ مدفوعة، تعريفٌ ومراجع، ثمّ موتُ الخادم يُقال غيرَ متاح", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lsp-"))
    try {
      writeFileSync(join(dir, "server.cjs"), FAKE_SERVER)
      const transport = new StdioLspTransport({ command: ["node", join(dir, "server.cjs")], cwd: dir })
      const client = new LspClient({ transport, rootUri: fileUri(dir), languageId: "typescript", requestTimeoutMs: 5000 })
      const init = await client.initialize()
      expect(init.kind).toBe("ok")
      const uri = fileUri(join(dir, "a.ts"))
      client.didOpenOrChange(uri, "const x: number = 'boom'\n")
      await Bun.sleep(150)
      const diag = client.diagnosticsFor(uri)
      expect(diag.kind).toBe("ok")
      if (diag.kind === "ok") expect(diag.value[0]!.message).toBe("Type boom")
      // الشدّةُ على السلك رقمٌ (1) والعقدُ يريدها اسماً — الناقلُ يحوّلها ويُلحق uri الملفّ
      if (diag.kind === "ok") expect(diag.value[0]).toMatchObject({ severity: "error", uri }) // uri كما فُتح رغم ترميز الخادم
      if (diag.kind === "ok") expect(diag.value.map((d) => d.severity)).toEqual(["error", "warning", "information", "hint", "error"])
      expect(transport.publishCount(uri)).toBe(1) // «أجاب» بعدّادِ نشرٍ لا بمصفوفة
      // نصٌّ غيرُ ASCII: Content-Length بالبايتات في الاتجاهين — الطلبُ التالي ما زال يمرّ
      client.didOpenOrChange(uri, "const س = 'مرحبا'\n")
      const def = await client.definition(uri, { line: 0, character: 6 })
      expect(def.kind).toBe("ok")
      if (def.kind === "ok") expect(def.value[0]!.range.start.line).toBe(2)
      const refs = await client.references(uri, { line: 0, character: 6 })
      expect(refs.kind).toBe("ok")
      if (refs.kind === "ok") expect(refs.value).toHaveLength(2)
      // الموت: الطلبُ التالي غيرُ متاح لا فارغ
      transport.notify("die", {})
      await transport.exited()
      const after = await client.references(uri, { line: 0, character: 6 })
      expect(after.kind).toBe("unavailable")
      expect(client.status().state).toBe("crashed")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20_000)

  test("locateServer: node_modules/.bin أوّلاً، ثمّ PATH إن سُمح، وإلا لا شيء", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lsp-locate-"))
    try {
      expect(locateServer(["typescript-language-server", "--stdio"], dir, false)).toBeUndefined()
      expect(locateServer(["typescript-language-server", "--stdio"], dir, true)).toEqual(["typescript-language-server", "--stdio"])
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
      writeFileSync(join(dir, "node_modules", ".bin", "typescript-language-server.cmd"), "@echo off")
      const found = locateServer(["typescript-language-server", "--stdio"], dir, false)!
      expect(found[0]).toContain(".bin")
      expect(found).toEqual([found[0], "--stdio"]) // الوسائطُ تبقى مع المسار
      expect(fileUri("C:\\Users\\x\\a.ts")).toBe("file:///C:/Users/x/a.ts")
      expect(fileUri("C:\\Users\\Abdel Rahman\\a.ts")).toBe("file:///C:/Users/Abdel%20Rahman/a.ts")
      expect(canonicalUri("file:///c%3A/Users/Abdel%20Rahman/a.ts")).toBe(canonicalUri("file:///C:/Users/Abdel Rahman/a.ts"))
      expect(canonicalUri("file:///x/a%zz.ts")).toBe("file:///x/a%zz.ts") // ترميزٌ معطوب لا يرمي
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
