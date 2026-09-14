import { describe, expect, test } from "bun:test"
import { ANCHORS, empty, entryOf, has, isAnchor, mountedIds, register, slot, unregister } from "../src/shells/slots"

// IDEA 6 — سجلّ نقاط التعليق: العقد المُعلَن، بنداً بنداً. كلُّ اختبارٍ هنا
// يقابل جملةً في رأس `slots.ts` — فإن سقطت الجملة سقط الاختبار معها.

const contribution = (id: string, anchor: string, feature: string, order?: number) => ({ id, anchor, feature, order })

describe("slot registry — the declared contract", () => {
  test("anchors are closed by name: an unknown one is refused BY NAME, not swallowed", () => {
    const state = empty()
    const folded = register(state, contribution("x:1", "composer.side", "x"))
    expect(folded.refused).toBe('مرساة غير معروفة: "composer.side"')
    // والحالة لا تُمسّ: لا تسجيلَ في العدم.
    expect(folded.state).toBe(state)
    expect(folded.mounted).toBeUndefined()
    expect(mountedIds(folded.state)).toEqual([])
    // ومراسي الجرد الأربع مُعلَنةٌ بأسمائها، والخامسة مقيسةٌ من موضعها.
    expect([...ANCHORS]).toEqual(["composer.bar", "transcript.node", "tab.strip", "settings.section", "activity.section", "rail.icons", "header.actions", "dock.inline-end", "dock.inline-start", "dock.block-end", "dock.block-start"])
    for (const anchor of ANCHORS) expect(isAnchor(anchor)).toBe(true)
    expect(isAnchor("composer.side")).toBe(false)
    expect(isAnchor(undefined)).toBe(false)
  })

  test("a contribution without an id or an owning feature is refused by name", () => {
    expect(register(empty(), contribution("", "tab.strip", "x")).refused).toBe("مساهمة بلا معرّف — لا تُسجَّل")
    expect(register(empty(), contribution("x:1", "tab.strip", "  ")).refused).toBe('مساهمة بلا ميزة مالكة: "x:1"')
  })

  test("a duplicate id is refused by name and the standing registration is NOT replaced", () => {
    const first = register(empty(), contribution("a:1", "tab.strip", "a", 5))
    const second = register(first.state, contribution("a:1", "transcript.node", "b", 1))
    expect(second.refused).toBe('تسجيل مكرّر لنقطة التعليق: "a:1"')
    expect(second.state).toBe(first.state)
    // الأولى بحالها: استبدالٌ صامت كان يترك شجرةً يتيمةً بلا مفكِّك.
    expect(entryOf(second.state, "a:1")).toMatchObject({ anchor: "tab.strip", feature: "a", order: 5 })
  })

  test("order decides, and registration sequence breaks the tie — not call order", () => {
    let state = empty()
    // تُسجَّل الأعلى رتبةً أوّلاً عمداً: لو كان الترتيب ترتيبَ النداء لظهرت أوّلاً.
    for (const input of [
      contribution("late:20", "tab.strip", "late", 20),
      contribution("early:10", "tab.strip", "early", 10),
      contribution("tieA", "tab.strip", "tieA", 10),
      contribution("tieB", "tab.strip", "tieB", 10),
    ]) {
      const folded = register(state, input)
      expect(folded.refused).toBeUndefined()
      state = folded.state
    }
    expect(slot(state, "tab.strip").map((entry) => entry.id)).toEqual(["early:10", "tieA", "tieB", "late:20"])
    // والرتبة الغائبة صفرٌ مُعلَن لا `NaN` يفسد المقارنة.
    const withDefault = register(state, { id: "bare", anchor: "tab.strip", feature: "bare" }).state
    expect(entryOf(withDefault, "bare")!.order).toBe(0)
    expect(slot(withDefault, "tab.strip")[0]!.id).toBe("bare")
    // ومِرساةٌ أخرى لا تختلط: كلُّ مِرساةٍ ترتيبُها وحدها.
    expect(slot(withDefault, "transcript.node")).toEqual([])
  })

  test("unregister removes the contribution from every read, and is idempotent", () => {
    const one = register(empty(), contribution("a:1", "tab.strip", "a")).state
    const two = register(one, contribution("a:2", "composer.bar", "a")).state
    expect(mountedIds(two, "a")).toEqual(["a:1", "a:2"])

    const torn = unregister(two, "a:1")
    expect(torn.torn).toBe("a:1")
    expect(has(torn.state, "a:1")).toBe(false)
    expect(entryOf(torn.state, "a:1")).toBeUndefined()
    expect(slot(torn.state, "tab.strip")).toEqual([])
    expect(mountedIds(torn.state, "a")).toEqual(["a:2"])

    // صامدٌ للتكرار: لا رفض، ولا خطأ، ولا حالةٌ تتغيّر.
    const again = unregister(torn.state, "a:1")
    expect(again.torn).toBeUndefined()
    expect(again.refused).toBeUndefined()
    expect(again.state).toBe(torn.state)
    expect(unregister(again.state, "never-registered").state).toBe(again.state)
  })

  test("the sequence counter is never reused, so a re-registration lands after its peers", () => {
    let state = empty()
    state = register(state, contribution("a", "tab.strip", "a")).state
    state = register(state, contribution("b", "tab.strip", "b")).state
    state = unregister(state, "a").state
    state = register(state, contribution("a", "tab.strip", "a")).state
    // «a» عاد بعد «b» لأن تسلسله جديد — لا يستعيد موضعه القديم خلسة.
    expect(slot(state, "tab.strip").map((entry) => entry.id)).toEqual(["b", "a"])
  })

  test("state is frozen: a reader cannot mutate the registry through what it hands back", () => {
    const state = register(empty(), contribution("a", "tab.strip", "a")).state
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.entries)).toBe(true)
    expect(() => (state.entries as { push: (x: unknown) => void }).push({})).toThrow()
    expect(() => (slot(state, "tab.strip") as { push: (x: unknown) => void }).push({})).toThrow()
  })

  test("mountedIds narrows to one feature — that is what «the toggle went off» unmounts", () => {
    let state = empty()
    state = register(state, contribution("trajectory:tab", "tab.strip", "trajectory")).state
    state = register(state, contribution("trajectory:view", "transcript.node", "trajectory")).state
    state = register(state, contribution("approvalTakeover:seat", "composer.bar", "approvalTakeover")).state
    expect(mountedIds(state, "trajectory")).toEqual(["trajectory:tab", "trajectory:view"])
    expect(mountedIds(state, "approvalTakeover")).toEqual(["approvalTakeover:seat"])
    expect(mountedIds(state)).toHaveLength(3)
    expect(mountedIds(state, "nobody")).toEqual([])
  })
})
