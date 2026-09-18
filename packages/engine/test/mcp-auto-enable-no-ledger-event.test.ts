import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// مقيس 2026-09-17: تفعيلُ عميل MCP تلقائيّاً عند «external-connect» كان يكتب حدثَ دفترٍ باسم الدور «shell»،
// ولا دورَ بهذا الاسم يُقبل في serve-journal، فيرمي emitOutput «serve_output_without_admission:shell» ويموت المحرّك
// كلُّه («توقّف المحرّك» في القشرة). الإيصالُ إطارا settings وexternal، والسطرُ إلى stderr وحده.
test("auto-enabling the MCP client never writes a ledger event for an unadmitted turn", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).not.toContain('emitEvent("shell"')
  const at = cli.indexOf("mcpClient: true } })")
  expect(at).toBeGreaterThan(0)
  const branch = cli.slice(at, at + 700)
  expect(branch).toContain('emit({ kind: "settings", settings: next, ...pluginFrameFields(next) })')
  expect(branch).toContain("process.stderr.write(")
  // الدفترُ يرمي فعلاً عند دورٍ غير مقبول — الفحصُ السلبي أعلاه له توأمُه هنا.
  const journal = readFileSync(join(import.meta.dir, "../../engine-host/src/serve-journal.ts"), "utf8")
  expect(journal).toContain("if (!this.#admissions.has(turnId)) throw new Error(`serve_output_without_admission:${turnId}`)")
})

// مقيس 2026-09-17: مسارُ أمرٍ مكسور جعل Bun.spawn يرمي ENOENT من مُنشئ McpSession فمات المحرّكُ كلُّه عند التوصيل التلقائيّ.
test("a session that cannot be spawned or handshaken is a named refusal, never an engine crash", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  const at = cli.indexOf("let session: import(\"./mind/external\").ToolProviderSession")
  expect(at).toBeGreaterThan(0)
  const block = cli.slice(at, at + 900)
  expect(block).toContain("tools = await session.handshake()")
  expect(block).toContain("} catch (error) {")
  expect(block).toContain("emit({ kind: \"refused\", why: `تعذّر توصيلُ المزوّد ${id}:")
})
