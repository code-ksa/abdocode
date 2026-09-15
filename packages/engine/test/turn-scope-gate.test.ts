import { expect, test } from "bun:test"
import { fileEditAllowedByTurn, scopeKey } from "../src/turn-scope-gate"

// د7ب — نطاقُ الدور للكتابة: ملفٌّ موجودٌ لم يُسمَّ ولم يُقرأ ولم يُنشأ في الدور يُرفض باسمه؛ وكلُّ طريقٍ من الخمسة يمرّ (التوأمُ الإيجابيّ).
const T0 = 1_000_000
const base = { exists: true, modifiedAtMs: T0 - 60_000, turnStartedAtMs: T0, taskText: "أضف زرّاً في الصفحة الرئيسية", readThisTurn: new Set<string>(), createdThisTurn: new Set<string>() }

test("an existing file the turn never named, read or created is refused by name, and the refusal tells the model to read first or ask", () => {
  const v = fileEditAllowedByTurn({ ...base, target: "package.json" })
  expect(v.ok).toBe(false)
  if (v.ok) throw new Error("unreachable")
  expect(v.why).toContain("رُفض تعديل package.json")
  expect(v.why).toContain("read package.json")
  expect(v.why).toContain("واسأله")
})

test("a new file always passes, and harness protocol files are outside the verdict", () => {
  expect(fileEditAllowedByTurn({ ...base, target: "app/new-thing.ts", exists: false, modifiedAtMs: undefined })).toEqual({ ok: true, why: "new" })
  expect(fileEditAllowedByTurn({ ...base, target: "ABDO-SPRINTS.md" })).toEqual({ ok: true, why: "protocol" })
  expect(fileEditAllowedByTurn({ ...base, target: ".abdo/state.json" })).toEqual({ ok: true, why: "protocol" })
})

test("named in the task: full path, basename with extension, or a meaningful stem — generic stems do not count", () => {
  expect(fileEditAllowedByTurn({ ...base, target: "app/page.tsx", taskText: "عدّل app/page.tsx وأضف الزرّ" })).toEqual({ ok: true, why: "named" })
  expect(fileEditAllowedByTurn({ ...base, target: "src\\components\\Header.tsx", taskText: "غيّر لون العنوان في Header.tsx" })).toEqual({ ok: true, why: "named" })
  expect(fileEditAllowedByTurn({ ...base, target: "src/pricing-table.ts", taskText: "أصلح pricing-table" })).toEqual({ ok: true, why: "named" })
  // «page» جذعٌ عامّ: ذكرُ «الصفحة» أو «page» لا يسمّي app/page.tsx
  expect(fileEditAllowedByTurn({ ...base, target: "app/page.tsx", taskText: "make the page nicer" }).ok).toBe(false)
  // الجذعُ يطابق كلمةً كاملة: «header» لا يسمّي headers.ts
  expect(fileEditAllowedByTurn({ ...base, target: "src/headers.ts", taskText: "fix the header" }).ok).toBe(false)
  // التطبيعُ العربيّ: تشكيلٌ في نصّ المهمّة لا يمنع المطابقة
  expect(fileEditAllowedByTurn({ ...base, target: "notes/خطة.md", taskText: "حدِّث خطّة.md" })).toEqual({ ok: true, why: "named" })
})

test("read or created this turn passes; the key is normalized on both sides", () => {
  expect(scopeKey(".\\App\\Page.tsx")).toBe("app/page.tsx")
  expect(scopeKey("./src//x.ts")).toBe("src/x.ts")
  expect(fileEditAllowedByTurn({ ...base, target: "App\\page.tsx", readThisTurn: new Set(["app/page.tsx"]) })).toEqual({ ok: true, why: "read" })
  expect(fileEditAllowedByTurn({ ...base, target: "lib/x.ts", createdThisTurn: new Set(["lib/x.ts"]) })).toEqual({ ok: true, why: "created" })
})

test("fresh on disk (born or changed after the turn started, e.g. a scaffold) passes; blanket permission passes", () => {
  expect(fileEditAllowedByTurn({ ...base, target: "package.json", modifiedAtMs: T0 + 5 })).toEqual({ ok: true, why: "fresh" })
  expect(fileEditAllowedByTurn({ ...base, target: "package.json", modifiedAtMs: T0 })).toEqual({ ok: true, why: "fresh" })
  expect(fileEditAllowedByTurn({ ...base, target: "package.json", modifiedAtMs: T0 - 1 }).ok).toBe(false)
  expect(fileEditAllowedByTurn({ ...base, target: "package.json", taskText: "نظّف كلّ الملفّات من التعليقات" })).toEqual({ ok: true, why: "blanket" })
  expect(fileEditAllowedByTurn({ ...base, target: "package.json", taskText: "rename the brand across the project" })).toEqual({ ok: true, why: "blanket" })
})
