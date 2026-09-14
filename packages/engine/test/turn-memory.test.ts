import { describe, expect, test } from "bun:test"
import { distillFact, recallBrief } from "../src/turn-memory"

describe("turn memory — S2 distillation", () => {
  test("recall finds an older relevant decision beyond the newest twelve records", () => {
    const facts = [{ key: "database-decision", value: "PostgreSQL uses Prisma migrations", sourceEventIds: ["decision-17"] }, ...Array.from({length: 30}, (_, i) => ({ key: `wrote:unrelated-${i}`, value: `Unrelated file ${i} updated` }))]
    const brief = recallBrief(facts, 700, "Review PostgreSQL Prisma migrations")
    expect(brief).toContain("PostgreSQL uses Prisma migrations")
    expect(brief).toContain("source=decision-17")
    expect(brief.length).toBeLessThanOrEqual(700)
    expect(brief.indexOf("database-decision")).toBeLessThan(brief.indexOf("wrote:unrelated"))
  })

  test("structured tasks are readable, unknown payloads stay out and stale success is historical", () => {
    const brief = recallBrief([{key:"turn:a",value:{goal:"إصلاح الفواتير",status:"checkpointed",credential:"DO_NOT_INJECT"}},{key:"tests:passing",value:"Earlier tests passed"}],700,"اصلح الفواتير")
    expect(brief).toContain("إصلاح الفواتير")
    expect(brief).toContain("checkpointed")
    expect(brief).not.toContain("[object Object]")
    expect(brief).not.toContain("DO_NOT_INJECT")
    expect(brief).toContain("Historical context")
    expect(brief).not.toContain("لا تعِد إثباتها")
    expect(recallBrief([{key:"old",value:"previous"},{key:"old",value:{unknown:true}}])).toBe("")
    expect(recallBrief([{key:"a",value:"x"}],20)).toBe("")
  })

  test("distills a passing build into a durable fact", () => {
    const f = distillFact("run npm run build", "✓ Compiled successfully in 300ms\nانتهى الأمر برمز 0")
    expect(f?.key).toBe("build:passing")
  })

  test("distills passing tests with a count", () => {
    const f = distillFact("run npm test", "Tests 9 passed (9)\nانتهى الأمر برمز 0")
    expect(f?.key).toBe("tests:passing")
    expect(String(f?.value)).toContain("9")
  })

  test("distills clean audit and a managed server url", () => {
    expect(distillFact("run npm audit", "found 0 vulnerabilities\nانتهى الأمر برمز 0")?.key).toBe("audit:clean")
    expect(distillFact("run npm start", "⚙ الخادم يعمل تحت إدارة النواة: «npm start» على http://127.0.0.1:3000 (pid 5)")?.key).toBe("server:url")
  })

  test("distills a write as a capability fact", () => {
    const f = distillFact("edit app/lib/db.ts :: a => b", "✍ app/lib/db.ts — كتابة ذرّية")
    expect(f?.key).toBe("wrote:app/lib/db.ts")
  })

  test("a failing build or a plain read distills nothing", () => {
    expect(distillFact("run npm run build", "error TS2554\nانتهى الأمر برمز 1")).toBeUndefined()
    expect(distillFact("read package.json", "بصمة المحتوى abc…")).toBeUndefined()
  })

  test("recall brief dedups by key keeping the latest and stays budgeted", () => {
    const brief = recallBrief([
      { key: "build:passing", value: "قديم" },
      { key: "build:passing", value: "npm run build ينجح" },
      { key: "audit:clean", value: "npm audit صفر ثغرات" },
    ])
    expect(brief).toContain("npm run build ينجح")
    expect(brief).not.toContain("قديم")
    expect(brief).toContain("audit صفر")
    expect(recallBrief([])).toBe("")
  })
})

describe("turn memory — explicit verdicts", () => {
  test("a failing verdict distills nothing from a test receipt whose text reads exit 0", () => {
    const output = "3 passed\nانتهى الأمر برمز 0"
    expect(distillFact("run npm test", output)?.key).toBe("tests:passing")
    expect(distillFact("run npm test", output, { ok: false, reason: "aborted", denied: false })).toBeUndefined()
  })

  test("an ok verdict distills passing tests from a markerless receipt", () => {
    expect(distillFact("run npm test", "Tests 9 passed (9)")).toBeUndefined()
    expect(distillFact("run npm test", "Tests 9 passed (9)", { ok: true })?.key).toBe("tests:passing")
  })
})
