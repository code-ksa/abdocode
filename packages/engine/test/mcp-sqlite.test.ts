/**
 * خادمُ MCP خاصّتنا لـSQLite — يُهاجَم قبل أن يُصدَّق.
 *
 * الفكرةُ من خوادم MCP المرجعيّة والكودُ ملكنا، فالحرّاسُ ملكنا أيضاً — ولا
 * تُورَّث ثقةٌ من تصميمٍ لم نكتبه. وأكثرُ هذا الملفّ **هجومٌ**: كتابةٌ بكلّ
 * صيغةٍ تخطر، وضمُّ ملفٍّ آخر، وجملتان في نداء، وتعليقٌ يخفي الفعل.
 *
 * والحكمُ الحاكم يأتي من **المحرّك** لا من التعبير النمطيّ: الاتّصالُ للقراءة،
 * فحتى لو أفلتت جملةٌ من الفحص الشكليّ ترفضها SQLite نفسُها. ولذلك يُقاس
 * الأمران: أنّ الشكلَ يرفض، وأنّ القرصَ **لم يتغيّر** بعد المحاولة.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeStatement, MAX_ROWS, renderRows, runTool } from "../src/mcp-servers/sqlite"

const seeded = (): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-mcp-sqlite-"))
  const path = join(dir, "dev.db")
  const write = new Database(path, { create: true })
  write.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, secret TEXT)")
  write.run("INSERT INTO users (name, secret) VALUES ('نورة', 's1'), ('عمر', 's2')")
  write.run("CREATE VIEW names AS SELECT name FROM users")
  write.close()
  return { dir, path }
}

describe("حكمُ الجملة — الشكلُ يرفض بسببٍ مسمّى", () => {
  test("القراءةُ تمرّ بصيغها الأربع", () => {
    for (const sql of [
      "SELECT 1",
      "  select * from users where id = 1  ",
      "WITH t AS (SELECT 1 AS a) SELECT a FROM t",
      "EXPLAIN SELECT 1",
      "VALUES (1),(2)",
    ]) expect(`${sql.trim().slice(0, 18)}: ${judgeStatement(sql).ok}`).toBe(`${sql.trim().slice(0, 18)}: true`)
  })

  test("كلُّ كتابةٍ تُرفض، وبكلّ صيغةٍ تخطر", () => {
    for (const sql of [
      "INSERT INTO users (name) VALUES ('x')",
      "UPDATE users SET name='x'",
      "DELETE FROM users",
      "DROP TABLE users",
      "CREATE TABLE t (a)",
      "ALTER TABLE users ADD COLUMN c TEXT",
      "REPLACE INTO users VALUES (1,'a','b')",
      "PRAGMA journal_mode = WAL",
      "BEGIN; DELETE FROM users; COMMIT",
    ]) expect(`${sql.slice(0, 20)}: ${judgeStatement(sql).ok}`).toBe(`${sql.slice(0, 20)}: false`)
  })

  test("⚠ البابُ الوحيدُ الذي لا يسدّه readonly: ضمُّ ملفٍّ آخر — يُرفض بالاسم", () => {
    // اتّصالٌ للقراءة يستطيع `ATTACH` ويقرأ ملفّاً خارج المسموح. هذا هو السببُ
    // الوحيدُ لوجود الفحص الشكليّ أصلاً.
    for (const sql of [
      "ATTACH DATABASE 'C:/other.db' AS o",
      "attach '/etc/passwd' as p",
      "SELECT load_extension('evil.dll')",
      "SELECT 1; ATTACH 'x' AS y",
      "/* comment */ ATTACH 'x' AS y",
    ]) {
      const verdict = judgeStatement(sql)
      expect(`${sql.slice(0, 22)}: ${verdict.ok}`).toBe(`${sql.slice(0, 22)}: false`)
    }
  })

  test("التعليقُ لا يخفي الفعل، والجملتان في نداءٍ تُرفضان", () => {
    expect(judgeStatement("-- SELECT\nDELETE FROM users").ok).toBe(false)
    expect(judgeStatement("/* SELECT */ DROP TABLE users").ok).toBe(false)
    expect(judgeStatement("SELECT 1; DELETE FROM users").ok).toBe(false)
    // وفاصلةٌ منقوطةٌ في آخر جملةٍ واحدةٍ مقبولة — الحارسُ لا يحجب المشروع.
    expect(judgeStatement("SELECT 1;").ok).toBe(true)
    // وفاصلةٌ داخل نصٍّ ليست فاصلَ جملٍ — وإلّا رُفض كلُّ استعلامٍ فيه «;».
    expect(judgeStatement("SELECT 'a;b' AS x").ok).toBe(true)
  })
})

describe("التنفيذُ على قاعدةٍ حقيقيّة — والقرصُ يشهد", () => {
  test("الجداولُ والمَشاهدُ والمخطّطُ تُقرأ، والاسمُ مُعامَلٌ مربوط", () => {
    const { dir, path } = seeded()
    const database = new Database(path, { readonly: true, create: false })
    try {
      expect(runTool(database, "tables", {}).text).toContain("users")
      expect(runTool(database, "tables", {}).text).toContain("names")
      expect(runTool(database, "schema", { table: "users" }).text).toContain("CREATE TABLE users")
      // اسمٌ غيرُ موجودٍ يُرفض ولا يُحقن: لو لُصق في الجملة لانفجرت هنا.
      const injected = runTool(database, "schema", { table: "users'; DROP TABLE users; --" })
      expect(injected.ok).toBe(false)
      expect(injected.text).toContain("لا جدولَ")
      // والجدولُ باقٍ بعدها.
      expect(runTool(database, "tables", {}).text).toContain("users")
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("⚠ الحارسُ الحقيقيّ: المحرّكُ يرفض الكتابة، والقرصُ لا يتغيّر", () => {
    const { dir, path } = seeded()
    const before = { size: statSync(path).size, bytes: readFileSync(path) }
    const database = new Database(path, { readonly: true, create: false })
    try {
      // نتجاوز الفحصَ الشكليَّ عمداً بنداء المحرّك رأساً: هذا يقيس الطبقةَ
      // التي تحت الحارس، وهي التي تحمي لو أفلت شكلٌ يوماً.
      expect(() => database.run("DELETE FROM users")).toThrow()
      expect(() => database.run("INSERT INTO users (name) VALUES ('x')")).toThrow()
      // ومن خلال الأداة: رفضٌ مسمّى لا انفجار.
      const refused = runTool(database, "query", { sql: "DELETE FROM users" })
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain("ليست قراءة")
      // والصفوفُ كما كانت.
      expect(runTool(database, "query", { sql: "SELECT COUNT(*) AS n FROM users" }).text).toContain("2")
    } finally {
      database.close()
    }
    // **القرصُ يشهد**: البايتاتُ نفسُها، لا الحجمُ وحده.
    expect(statSync(path).size).toBe(before.size)
    expect(Buffer.compare(readFileSync(path), before.bytes)).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("السقوفُ تُطبَّق، والقطعُ يُعلَن ولا يُخفى", () => {
    const rows = Array.from({ length: MAX_ROWS + 25 }, (_, i) => ({ id: i, name: `n${i}` }))
    const text = renderRows(rows)
    expect(text).toContain(`وقُطع 25 صفّاً عند سقف ${MAX_ROWS}`)
    expect(text.split("\n").length).toBeLessThan(MAX_ROWS + 6)
    // والفراغُ يُقال باسمه لا ببياض.
    expect(renderRows([])).toBe("(لا صفوف)")
  })
})
