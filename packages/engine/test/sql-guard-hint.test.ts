/**
 * 09-30 — مقيس على مهمّة OpenRouter: مسارُ /api/models بفلاترَ اختياريّة رُفض ستَّ مرّاتٍ قبل أن يصل النموذجُ بنفسه إلى البنية الثابتة.
 * الكشفُ لم يتغيّر؛ الرفضُ يسمّي البنيةَ الآمنة، والبنيةُ التي انتهى إليها النموذجُ (من مشروع المالك) تمرّ.
 */
import { describe, expect, test } from "bun:test"
import { secretInSourceViolation } from "../src/secret-command-guard"

const route = (body: string) => ({ normalizedTarget: "src/app/api/models/route.ts", after: `import Database from 'better-sqlite3'\nconst db = new Database('data/app.db')\nexport async function GET(req: Request) {\n${body}\n}` })

describe("SQL interpolation guard names the safe shape", () => {
  test("interpolating a value is still refused, and the refusal shows the fixed optional-filter shape", () => {
    const why = secretInSourceViolation(route("  const rows = db.prepare(`SELECT * FROM models WHERE name LIKE '%${search}%'`).all()"))
    expect(why).toContain("رُفض بناء SQL")
    expect(why).toContain("(? = 0 OR name LIKE ?)")
    expect(why).toContain("LIMIT ? OFFSET ?")
    expect(secretInSourceViolation(route("  const rows = db.prepare('SELECT * FROM models WHERE id = ' + id).all()"))).toContain("رُفض بناء SQL")
  })

  test("red team: every string form that splices a value is refused (the quoted LIKE form used to pass)", () => {
    for (const line of [
      "  db.prepare(`SELECT * FROM models WHERE name LIKE '%${q}%'`).all()",
      "  db.prepare(`SELECT * FROM models WHERE id = ${id}`).get()",
      "  db.all(`SELECT * FROM models ORDER BY ${sort}`)",
      "  db.execute(`DELETE FROM keys WHERE id=${id}`)",
      "  db.query(\"SELECT * FROM t WHERE a = '\" + x + \"'\")",
      "  db.prepare('SELECT * FROM t WHERE name = \"' + name + '\"').get()",
      "  db.prepare(`SELECT * FROM models ` + where).all()",
    ]) expect([line, secretInSourceViolation(route(line))?.slice(0, 14)]).toEqual([line, "رُفض بناء SQL "])
  })

  test("the opposite direction: bound parameters and non-SQL templates pass", () => {
    for (const line of [
      "  db.prepare('SELECT * FROM t WHERE a = ?').get(x)",
      "  db.prepare(`SELECT * FROM t WHERE a = ? AND b = ?`).all(a, b)",
      "  db.prepare(\"INSERT INTO t (a, b) VALUES (?, ?)\").run(a, b)",
      "  const greeting = `hello ${name}`",
      "  const like = `%${search}%`",
    ]) expect([line, secretInSourceViolation(route(line))]).toEqual([line, undefined])
  })

  test("the twin: the fixed structure the model reached passes", () => {
    const safe = [
      "  const searchTerm = hasSearch ? `%${search}%` : ''",
      "  const dataStmt = db.prepare(`",
      "    SELECT id, name, provider FROM models",
      "    WHERE",
      "      (? = 0 OR LOWER(name) LIKE ? OR LOWER(provider) LIKE ? OR LOWER(id) LIKE ?)",
      "    ORDER BY name",
      "    LIMIT ? OFFSET ?",
      "  `)",
      "  const rows = dataStmt.all(hasSearch ? 1 : 0, searchTerm, searchTerm, searchTerm, limit, offset)",
    ].join("\n")
    expect(secretInSourceViolation(route(safe))).toBeUndefined()
  })
})
