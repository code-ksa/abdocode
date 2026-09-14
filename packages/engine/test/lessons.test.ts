import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPEAT_LIMIT, SqliteFactStore } from "@abdo/memory"
import { LESSON_PREFIX, confirmed, failureOf, lessonBrief, lessonEventLine, lessonKey, lessonsOf, recordLesson, repeatVerdict } from "../src/lessons"

// ذ3 — الدرسُ قياسٌ من إيصالٍ حقيقيّ، مقيَّدٌ بالمشروع، ويعود بالاسم قبل الفعل نفسه.

const BUILD_FAIL = "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nnpm ERR! code ELIFECYCLE\nانتهى الأمر برمز 1"

describe("ما يصير درساً", () => {
  test("فشلٌ ذاتيّ ببصمةٍ مطبَّعة يصير درساً؛ الجدارُ الخارجيّ والعابرُ لا", () => {
    const f = failureOf("run npm run build", BUILD_FAIL, "build")
    expect(f).toBeDefined()
    expect(f!.taskKind).toBe("build")
    expect(f!.signature).not.toContain("12,5")
    expect(f!.signature).toContain("tsN")
    // جدارُ بيئة: له متتبّعُه، وليس درساً يُعلَّم منه تجنّبُ أمرٍ سليم.
    expect(failureOf("run npm test", "'taskkill' is not recognized as an internal or external command\nانتهى الأمر برمز 1", "test")).toBeUndefined()
    expect(failureOf("run npm run build", "   ", "build")).toBeUndefined()
  })

  test("المفتاحُ ثابتٌ للحادثة نفسها وإن اختلف السطرُ والعمود والمسارُ المطلق", () => {
    const a = failureOf("run npm run build", BUILD_FAIL, "build")!
    // الأعدادُ تُطوى N: السطرُ والعمودُ المختلفان حادثةٌ واحدة.
    const b = failureOf("run npm run build", BUILD_FAIL.replace("src/app.ts(12,5)", "src/app.ts(99,1)"), "build")!
    expect(lessonKey(a.taskKind, a.signature)).toBe(lessonKey(b.taskKind, b.signature))
    // والمسارُ المطلق يُطوى /P (النسبيُّ بلا فاصلٍ في صدره لا يُطوى — قاعدةُ normalizeErrorSignature).
    const c = failureOf("run npm run build", BUILD_FAIL.replace("src/app.ts(12,5)", "C:\\proj\\src\\app.ts(12,5)"), "build")!
    expect(c.signature).toContain("/P(N,N)")
    expect(c.signature).not.toContain("proj")
    expect(lessonKey(a.taskKind, a.signature).startsWith(`${LESSON_PREFIX}build:`)).toBe(true)
    expect(lessonKey("test", a.signature)).not.toBe(lessonKey("build", a.signature))
  })

  test("التكرارُ يزيد العدّاد ويحفظ أوّلَ دورٍ وآخرَه، والحكمُ ذو الأسنان يسمّي الأمرَ المحظور", () => {
    const f = failureOf("run npm run build", BUILD_FAIL, "build")!
    const first = recordLesson(undefined, f, "t1", BUILD_FAIL)
    expect(first).toMatchObject({ hits: 1, firstTurn: "t1", lastTurn: "t1" })
    expect(confirmed(first)).toBe(false)
    expect(repeatVerdict(first).kind).toBe("proceed")
    const second = recordLesson(first, f, "t2", BUILD_FAIL)
    expect(second).toMatchObject({ hits: REPEAT_LIMIT, firstTurn: "t1", lastTurn: "t2" })
    expect(confirmed(second)).toBe(true)
    const verdict = repeatVerdict(second)
    expect(verdict.kind).toBe("escalate")
    expect(lessonEventLine(second)).toContain("2×")
    expect(lessonEventLine(second)).toContain("الحكم:")
    expect(lessonEventLine(first)).not.toContain("الحكم:")
  })
})

describe("القراءةُ من الحقائق", () => {
  const f = failureOf("run npm run build", BUILD_FAIL, "build")!
  const lesson = recordLesson(undefined, f, "t1", BUILD_FAIL)
  const key = lessonKey(f.taskKind, f.signature)

  test("درسُ الجلسة ليس درسَ المشروع، والقيمةُ المشوَّهة تُسقَط، والأحدثُ يفوز لكلّ مفتاح", () => {
    const facts = [
      { key, value: lesson, sessionId: "s1" },
      { key: "owner-note:x", value: lesson },
      { key, value: { ...lesson, hits: "2" } },
      { key, value: lesson },
      { key, value: { ...lesson, hits: 3 } },
    ]
    const read = lessonsOf(facts)
    expect(read).toHaveLength(1)
    expect(read[0]!.hits).toBe(3)
    expect(lessonsOf([])).toEqual([])
  })

  test("الموجزُ فارغٌ بلا درس — بايتاً كما كان — والمؤكَّدُ أوّلاً ومحدودُ العدد بإعلان المحذوف", () => {
    expect(lessonBrief([])).toBe("")
    const many = Array.from({ length: 7 }, (_, i) => ({ ...lesson, command: `run cmd-${i}`, hits: i === 3 ? 2 : 1 }))
    const brief = lessonBrief(many)
    expect(brief.startsWith("دروسُ هذا المشروع")).toBe(true)
    expect(brief).toContain("(أُظهر 5 من 7)")
    expect(brief.indexOf("run cmd-3")).toBeLessThan(brief.indexOf("run cmd-0"))
    expect(brief).toContain("محاولةٌ رابعةٌ لا مثابرة")
    expect(brief.split("\n").filter((l) => l.startsWith("  - «run")).length).toBe(5)
  })

  test("القيدُ بالمشروع في المخزن الحقيقيّ: درسُ مشروعٍ لا يظهر لمشروعٍ آخر (توأمٌ إيجابيّ وسلبيّ)", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lessons-"))
    const store = new SqliteFactStore(join(dir, "memory.sqlite"))
    try {
      const fact = store.record({ projectId: "C:/projects/A", kind: "project_fact", key, value: lesson, sourceEventIds: ["turn:t1:epoch:2"] })
      store.verify(fact.id)
      const forA = lessonsOf(store.query({ projectId: "C:/projects/A", sessionId: "other-session", now: Date.now() }).facts)
      expect(forA).toHaveLength(1)
      expect(forA[0]!.command).toBe("run npm run build")
      const forB = lessonsOf(store.query({ projectId: "C:/projects/B", sessionId: "other-session", now: Date.now() }).facts)
      expect(forB).toEqual([])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
