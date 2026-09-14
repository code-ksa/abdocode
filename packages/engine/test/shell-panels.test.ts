import { describe, expect, test } from "bun:test"
import { DOCKS, dock, empty, entryOf, expand, hasUnseen, inDock, isDock, noticed, seen, unseenIds } from "../src/shells/panels"

/**
 * النقطةُ الزرقاء تُثبَّت بمُخفِّضٍ نقيّ لا بمؤقّت — فتُختبر بجدولٍ صريح،
 * ولا يحتاج إثباتُها متصفّحاً ولا انتظاراً.
 */
describe("حالةُ الألواح — ما لا يملكه السجلّ", () => {
  test("المِراسي مغلقةٌ بالاسم، والاسمُ الغريب يُرفض مسمّى ولا يمسّ الحالة", () => {
    expect([...DOCKS]).toEqual(["inline-end", "inline-start", "block-end", "block-start"])
    for (const d of DOCKS) expect(isDock(d)).toBe(true)
    const state = empty()
    const bad = dock(state, "terminal", "top")
    expect(bad.refused).toContain("top")
    expect(bad.state).toBe(state)
    // التوأمُ الإيجابي: المعلَنةُ تُقبل فعلاً — وإلا كان الرفضُ جموداً لا حراسة.
    expect(dock(state, "terminal", "block-end").refused).toBeUndefined()
    expect(dock(state, "", "block-end").refused).toContain("بلا معرّف")
  })

  test("النقلُ يحفظ التوسيعَ والنقطة — تحريكُ لوحٍ ليس رؤيةً لما فيه", () => {
    let s = dock(empty(), "terminal", "block-end").state
    s = noticed(s, "terminal", false).state
    s = expand(s, "terminal", true).state
    expect(entryOf(s, "terminal")).toMatchObject({ dock: "block-end", expanded: true, unseen: true })
    s = dock(s, "terminal", "inline-start").state
    expect(entryOf(s, "terminal")).toMatchObject({ dock: "inline-start", expanded: true, unseen: true })
  })

  test("حدثٌ على لوحٍ مغلقٍ يرفع النقطة، وعلى مفتوحٍ لا يرفع شيئاً", () => {
    const closed = noticed(empty(), "servers", false).state
    expect(hasUnseen(closed, "servers")).toBe(true)
    // مفتوحٌ: المستخدم يراه — ونقطةٌ على المنظور تموت كإشارة.
    const open = noticed(empty(), "servers", true).state
    expect(hasUnseen(open, "servers")).toBe(false)
    expect(open.entries).toEqual([])
  })

  test("الفتحُ يطفئ النقطة، والإطفاءُ صامدٌ للتكرار ولِلوحٍ لا قيدَ له", () => {
    let s = noticed(empty(), "terminal", false).state
    expect(hasUnseen(s, "terminal")).toBe(true)
    s = seen(s, "terminal").state
    expect(hasUnseen(s, "terminal")).toBe(false)
    // مرّةً ثانية: لا رفضَ ولا تغيير — المُنادي كثيراً ما يطفئ ما أُطفئ.
    const again = seen(s, "terminal")
    expect(again.refused).toBeUndefined()
    expect(again.state).toBe(s)
    expect(seen(empty(), "ghost").state).toEqual(empty())
  })

  test("التوسيعُ لا يُخترع لِلوحٍ غير مُرسىً — رفضٌ مسمّى", () => {
    const bad = expand(empty(), "ghost", true)
    expect(bad.refused).toContain("ghost")
    expect(bad.state).toEqual(empty())
  })

  test("لا عَلَمَ انفتاحٍ هنا — السجلُّ يملكه وحده", () => {
    // القاعدةُ التي تمنع أيقونةً تكذب على لوحها: لو ظهر حقلُ `open` هنا
    // لصار للسؤال مالكان. يُثبَّت بالشكل لا بالنيّة.
    const s = dock(empty(), "terminal", "block-end").state
    expect(Object.keys(entryOf(s, "terminal")!).sort()).toEqual(["dock", "expanded", "id", "unseen"])
  })

  test("الجردُ يخدم الترويسة: من عليه نقطة، وما في كلّ مِرساة", () => {
    let s = dock(empty(), "terminal", "block-end").state
    s = dock(s, "servers", "inline-end").state
    s = dock(s, "outputs", "inline-end").state
    s = noticed(s, "terminal", false).state
    s = noticed(s, "servers", false).state
    expect([...unseenIds(s)].sort()).toEqual(["servers", "terminal"])
    expect(inDock(s, "inline-end").map((e) => e.id)).toEqual(["servers", "outputs"])
    expect(inDock(s, "block-end").map((e) => e.id)).toEqual(["terminal"])
    expect(inDock(s, "nowhere")).toEqual([])
  })

  test("خالصةٌ ومجمَّدة: كلُّ طيّةٍ تعيد حالةً جديدةً ولا تمسّ القديمة", () => {
    const a = dock(empty(), "terminal", "block-end").state
    const snapshot = JSON.stringify(a)
    const b = noticed(a, "terminal", false).state
    expect(JSON.stringify(a)).toBe(snapshot)
    expect(b).not.toBe(a)
    expect(Object.isFrozen(b.entries)).toBe(true)
  })
})
