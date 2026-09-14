import { describe, expect, test } from "bun:test"
import { panelFrame } from "../src/shells/panel-frame"
import type { Bind, SlotDocument, SlotElement } from "../src/shells/slot-host"

/**
 * بديلٌ صارم لا متصفّح: كلُّ عقدةٍ تُحصى وكلُّ مستمعٍ يُحصى، فالفكُّ يُقاس
 * ولا يُوصف — كما في `shell-slot-teardown`. وحدُّه معلَنٌ بصدق: يُثبت أنّ
 * الترويسة تُبنى وتُفكّ، لا أنّ متصفّحاً يرسمها كما نظنّ.
 */
class Node implements SlotElement {
  readonly children: Node[] = []
  readonly attrs = new Map<string, string>()
  readonly listeners: { type: string; handler: (event: never) => void }[] = []
  parent: Node | null = null
  id?: string
  className?: string
  hidden?: boolean
  textContent?: string | null
  type?: string
  value?: string
  constructor(readonly tag: string, readonly doc: Doc) {}
  get ownerDocument(): SlotDocument { return this.doc }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  appendChild(node: SlotElement): unknown { const n = node as Node; n.parent = this; this.children.push(n); return n }
  insertBefore(node: SlotElement, before: SlotElement | null): unknown {
    const n = node as Node; n.parent = this
    const at = before === null ? this.children.length : this.children.indexOf(before as Node)
    this.children.splice(at < 0 ? this.children.length : at, 0, n)
    return n
  }
  removeChild(node: SlotElement): unknown {
    const at = this.children.indexOf(node as Node)
    if (at < 0) throw new Error("removeChild: ليست ابناً")
    this.children.splice(at, 1)
    return node
  }
  addEventListener(type: string, handler: (event: never) => void): void { this.listeners.push({ type, handler }) }
  removeEventListener(type: string, handler: (event: never) => void): void {
    const at = this.listeners.findIndex((l) => l.type === type && l.handler === handler)
    if (at < 0) throw new Error("removeEventListener: لم يُعلَّق")
    this.listeners.splice(at, 1)
  }
  walk(): Node[] { return [this, ...this.children.flatMap((c) => c.walk())] }
  find(cls: string): Node[] { return this.walk().filter((n) => n.className === cls) }
}
class Doc implements SlotDocument { createElement(tag: string): SlotElement { return new Node(tag, this) } }

const harness = (expanded = false) => {
  const doc = new Doc()
  const host = new Node("div", doc)
  const bound: { target: Node; type: string; handler: (event: never) => void }[] = []
  const bind: Bind = (target, type, handler) => { (target as Node).addEventListener(type, handler); bound.push({ target: target as Node, type, handler }) }
  const calls: string[] = []
  const frame = panelFrame({
    document: doc,
    title: "الطرفيّة",
    action: { label: "＋", title: "لسانٌ جديد", onClick: () => calls.push("action") },
    onExpand: (next) => calls.push("expand:" + next),
    onClose: () => calls.push("close"),
    expanded,
  }, host, bind)
  return { doc, host, frame, calls, bound }
}

describe("ترويسةُ اللوح — عقدةٌ واحدةٌ لكلّ لوح", () => {
  test("تحمل الاسمَ والفعلَ الخاصّ والثابتَين، ولكلٍّ اسمٌ لقارئ الشاشة", () => {
    const { host, calls } = harness()
    const buttons = host.find("iconbtn")
    expect(buttons.length).toBe(3)
    for (const b of buttons) {
      expect(b.attrs.get("aria-label")).toBeTruthy()
      expect(b.attrs.get("title")).toBeTruthy()
      // زرٌّ داخل نموذجٍ بلا `type` يُرسل — تصريحٌ لا افتراض.
      expect(b.attrs.get("type")).toBe("button")
    }
    expect(host.find("panel-name")[0]!.textContent).toBe("الطرفيّة")
    // كلُّ زرٍّ ينادي مالكَه — والترويسةُ لا تملك الحالة ولا تغيّرها بنفسها.
    for (const b of buttons) b.listeners[0]!.handler(undefined as never)
    expect(calls).toEqual(["action", "expand:true", "close"])
  })

  test("التوسيعُ يُقرأ من المُنادي لا من نسخةٍ هنا — والزرّ يعكس الحالة", () => {
    const open = harness(true)
    expect(open.frame.root.className).toBe("panel expanded")
    const closeBtn = open.host.find("iconbtn")[1]!
    expect(closeBtn.attrs.get("title")).toBe("أعِد اللوح إلى مرساته")
    closeBtn.listeners[0]!.handler(undefined as never)
    expect(open.calls).toEqual(["expand:false"])
    // والتوأمُ: غيرُ الموسَّع يعرض الفعلَ المعاكس — فالزرُّ ليس نصّاً ثابتاً.
    const shut = harness(false)
    expect(shut.frame.root.className).toBe("panel")
    expect(shut.host.find("iconbtn")[1]!.attrs.get("title")).toBe("وسّع اللوح")
  })

  test("لوحٌ بلا فعلٍ خاصّ يحمل الثابتَين وحدهما — لا زرَّ فارغ", () => {
    const doc = new Doc(); const host = new Node("div", doc)
    const bind: Bind = (t, ty, h) => (t as Node).addEventListener(ty, h)
    panelFrame({ document: doc, title: "الخوادم", onExpand: () => {}, onClose: () => {}, expanded: false }, host, bind)
    expect(host.find("iconbtn").length).toBe(2)
  })

  test("الجسمُ يُسلَّم فارغاً ليملأه اللوح — الترويسةُ لا تعرف ما فيه", () => {
    const { frame, host } = harness()
    expect(frame.body.className).toBe("panel-body")
    expect(frame.body.children.length).toBe(0)
    expect(host.children.length).toBe(1)
    expect(frame.body.parent).toBe(frame.root as Node)
  })

  test("زرُّ «نافذةٌ مستقلّة» يُشحن الآن — بعد أن قِيس أنّ الإنشاء لا يعلّق", () => {
    // كان هذا الفحصُ يثبّت **غيابَ** الزرّ عمداً، لأنّ المواصفة تَسِمُه بأنه
    // يحتاج قياساً و«ما لا يُقاس يُقال ولا يُشحن زرٌّ لا يعمل». وقد أُخذ
    // القياسُ على التطبيق الحقيقيّ (2026-09-04): الإنشاءُ من أمرٍ غيرِ متزامن
    // عاد في ٧٢ مللي ثانية والعمليةُ بقيت مستجيبة. فانقلب الفحصُ إلى إثبات
    // حضوره — والقاعدةُ لم تتغيّر: **الزرُّ يتبع القياس**.
    const doc = new Doc(); const host = new Node("div", doc)
    const bind: Bind = (target, type, handler) => (target as Node).addEventListener(type, handler)
    const popped: string[] = []
    panelFrame({
      document: doc, title: "الطرفيّة", expanded: false,
      onExpand: () => {}, onClose: () => {}, onPopout: () => popped.push("popout"),
    }, host, bind)
    const titles = host.find("iconbtn").map((b) => b.attrs.get("title"))
    expect(titles).toContain("افتح اللوح في نافذةٍ مستقلّة")
    // وترتيبُه قبل الثابتَين كما تصفه المواصفة.
    expect(titles).toEqual(["افتح اللوح في نافذةٍ مستقلّة", "وسّع اللوح", "أغلق اللوح"])
    host.find("iconbtn")[0]!.listeners[0]!.handler(undefined as never)
    expect(popped).toEqual(["popout"])
  })

  test("وغيابُ الطريق غيابُ الزرّ — لا زرٌّ صامتٌ في بيئةٍ لا تملكه", () => {
    // مُنادٍ بلا `onPopout` (متصفّحٌ عاديّ، أو بيئةٌ بلا تاوري) لا يُشحن له
    // زرٌّ ينقر فلا يحدث شيء — وهو أسوأ من غيابه لأنّه يُجرَّب ثمّ لا يُصدَّق.
    const { host } = harness()
    const titles = host.find("iconbtn").map((b) => b.attrs.get("title"))
    expect(titles.some((x) => x?.includes("نافذة"))).toBe(false)
    expect(titles).toContain("أغلق اللوح")
  })
})
