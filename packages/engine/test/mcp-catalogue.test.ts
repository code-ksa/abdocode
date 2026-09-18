/**
 * سوقُ الخوادم — مُخفِّضٌ نقيٌّ يُقاس وحده.
 *
 * وأثقلُ ما فيه قاعدةٌ واحدة: **المسارُ يُلحق بالأمر، والسرُّ لا**. قالبٌ يُلحق
 * رابطاً فيه كلمةُ مرورٍ يفتح ما أُغلق في المحرّك — سطرُ أمرِ أيّ عمليّةٍ مقروءٌ
 * لكلّ عمليّةٍ على الجهاز. والنوعُ يحرسها: `secret` لا تملك `appendToArgv`.
 */
import { describe, expect, test } from "bun:test"
import {
  MCP_PRESETS, presetById, presetCommand, presetHandle, uniqueId,
} from "../src/shells/mcp-catalogue"

describe("السوق — مغلقٌ على ما نشحن", () => {
  test("كلُّ قالبٍ يشير إلى أمرٍ فرعيٍّ في ثنائيّنا، ولا ينزّل شيئاً", () => {
    expect(MCP_PRESETS.length).toBeGreaterThan(0)
    for (const preset of MCP_PRESETS) {
      // ⚠ لا `npx` ولا `npm` ولا مسارٌ إلى حزمةِ غريب: القائمةُ لِما نشحنه.
      const joined = preset.argv.join(" ")
      expect(`${preset.id}: ${joined.startsWith("mcp-")}`).toBe(`${preset.id}: true`)
      for (const forbidden of ["npx", "npm", "pnpm", "curl", "http"]) {
        expect(`${preset.id}/${forbidden}: ${joined.includes(forbidden)}`).toBe(`${preset.id}/${forbidden}: false`)
      }
      expect(preset.tools.length).toBeGreaterThan(0)
      expect(preset.summary.length).toBeGreaterThan(20)
    }
    expect(presetById("db")?.label).toContain("SQLite")
    expect(presetById("لا-يوجد")).toBeUndefined()
  })

  test("المسارُ يُلحق بالأمر، والسرُّ لا يُلحق أبداً", () => {
    const prefix = ["C:/app/abdocode.exe"]
    const sqlite = presetById("db")!
    const built = presetCommand(sqlite, prefix, " C:/p/dev.db ")
    expect(built).toEqual(["C:/app/abdocode.exe", "mcp-sqlite", "C:/p/dev.db"])

    // ⚠ الحاكم: قالبُ السرّ يبني أمراً **لا تظهر فيه القيمة**.
    const pg = presetById("pg")!
    const secret = "postgresql://u:SUPER-SECRET@h/db"
    const command = presetCommand(pg, prefix, secret)
    expect(Array.isArray(command)).toBe(true)
    if (!Array.isArray(command)) return
    expect(command).toEqual(["C:/app/abdocode.exe", "mcp-postgres"])
    expect(command.join(" ")).not.toContain("SUPER-SECRET")
    // والنوعُ نفسُه يمنع الخطأ: مُدخلُ السرّ لا يحمل `appendToArgv`.
    expect("appendToArgv" in pg.input).toBe(false)
    expect(pg.input.kind === "secret" ? pg.input.env : "").toBe("ABDO_PG_URL")
  })

  test("الفراغُ يُرفض بسببٍ مسمّى، وغيابُ أمرِ المحرّك كذلك", () => {
    const sqlite = presetById("db")!
    const empty = presetCommand(sqlite, ["x"], "   ")
    expect(Array.isArray(empty)).toBe(false)
    if (!Array.isArray(empty)) expect(empty.refusal).toContain(sqlite.input.label)
    const noEngine = presetCommand(sqlite, [], "C:/a.db")
    expect(Array.isArray(noEngine)).toBe(false)
    if (!Array.isArray(noEngine)) expect(noEngine.refusal).toContain("المحرّك")
  })

  test("المعرّفُ لا يصطدم بمحفوظ، والمقبضُ يُشتقّ كما في المنح اليدويّ", () => {
    expect(uniqueId("db", [])).toBe("db")
    expect(uniqueId("db", ["db"])).toBe("db-2")
    expect(uniqueId("db", ["db", "db-2", "db-3"])).toBe("db-4")
    // والقاعدةُ نفسُها التي تستعملها الواجهة، فلا مقبضان لسرٍّ واحد.
    expect(presetHandle("pg", "ABDO_PG_URL")).toBe("custom-pg-abdo-pg-url")
  })
})
