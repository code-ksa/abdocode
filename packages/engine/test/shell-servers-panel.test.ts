import { describe, expect, test } from "bun:test"
import { renderServers, serversPanel, SERVERS_PANEL_ID, type ServerRow } from "../src/shells/servers-panel"
import type { Bind, SlotDocument, SlotElement } from "../src/shells/slot-host"

class Node implements SlotElement {
  readonly children: Node[] = []
  readonly attrs = new Map<string, string>()
  readonly listeners: { type: string; handler: (event: never) => void }[] = []
  id?: string
  className?: string
  hidden?: boolean
  textContent?: string | null
  type?: string
  value?: string
  constructor(readonly tag: string, readonly doc: Doc) {}
  get ownerDocument(): SlotDocument { return this.doc }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v) }
  appendChild(node: SlotElement): unknown { this.children.push(node as Node); return node }
  insertBefore(node: SlotElement, before: SlotElement | null): unknown {
    const at = before === null ? this.children.length : this.children.indexOf(before as Node)
    this.children.splice(at < 0 ? this.children.length : at, 0, node as Node); return node
  }
  removeChild(node: SlotElement): unknown {
    const at = this.children.indexOf(node as Node)
    if (at < 0) throw new Error("removeChild: ليست ابناً")
    this.children.splice(at, 1); return node
  }
  addEventListener(t: string, h: (e: never) => void): void { this.listeners.push({ type: t, handler: h }) }
  removeEventListener(t: string, h: (e: never) => void): void {
    const at = this.listeners.findIndex((l) => l.type === t && l.handler === h)
    if (at < 0) throw new Error("removeEventListener: لم يُعلَّق")
    this.listeners.splice(at, 1)
  }
  walk(): Node[] { return [this, ...this.children.flatMap((c) => c.walk())] }
  text(): string { return this.walk().map((n) => n.textContent ?? "").join(" ") }
}
class Doc implements SlotDocument { createElement(tag: string): SlotElement { return new Node(tag, this) } }

const bind: Bind = (t, ty, h) => (t as Node).addEventListener(ty, h)

describe("لوحُ الخوادم — ما لا يُقاس يُقال ولا يُخفى", () => {
  test("الحالةُ ثلاثيّة: «يُقاس» ليست «غير عامل»", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    const rows: ServerRow[] = [
      { name: "web", port: 3000, state: "up" },
      { name: "api", port: 4000, state: "down", why: "المنفذ مغلق" },
      { name: "docs", port: 5000, state: "measuring" },
    ]
    renderServers(doc, list, rows, () => {}, bind)
    const text = list.text()
    expect(text).toContain("يعمل")
    expect(text).toContain("غير عامل — المنفذ مغلق")
    expect(text).toContain("يُقاس…")
    // الثلاثةُ حاضرةٌ كصفوف: لا صفَّ يُحذف لأنّ حكمه غيرُ مريح.
    expect(list.children.length).toBe(3)
    const classes = list.children.map((c) => c.className)
    expect(classes).toEqual(["srv-row srv-up", "srv-row srv-down", "srv-row srv-measuring"])
  })

  test("زرُّ الفتح لِما يعمل وحده — زرٌّ يفتح صفحةَ خطأٍ إحباطٌ لا فعل", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    const opened: string[] = []
    renderServers(doc, list, [
      { name: "up", port: 1, state: "up" },
      { name: "down", port: 2, state: "down" },
      { name: "measuring", port: 3, state: "measuring" },
    ], (r) => opened.push(r.name), bind)
    const buttons = list.walk().filter((n) => n.className === "iconbtn")
    expect(buttons.length).toBe(1)
    buttons[0]!.listeners[0]!.handler(undefined as never)
    expect(opened).toEqual(["up"])
  })

  test("الغيابُ يُقال باسمه، ولا يُترك فراغاً يُقرأ عطلاً", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    renderServers(doc, list, [], () => {}, bind)
    expect(list.text()).toContain("لا خادمَ مُدارٌ في هذه الجلسة")
  })

  test("الرسمُ من البيانات كلَّ مرّة — لا صفَّ خادمٍ ماتَ يبقى معلّقاً", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    renderServers(doc, list, [{ name: "a", port: 1, state: "up" }, { name: "b", port: 2, state: "up" }], () => {}, bind)
    expect(list.children.length).toBe(2)
    // القياسُ التالي يقول «واحدٌ فقط» — والقائمةُ تتبعه ولا تتراكم.
    renderServers(doc, list, [{ name: "b", port: 2, state: "up" }], () => {}, bind)
    expect(list.children.length).toBe(1)
    expect(list.text()).toContain("b")
    expect(list.text()).not.toContain("a")
  })

  test("التركيبُ يطلب قياساً فوراً، والفكُّ يقطع الوصل قبل أن يُهدم", () => {
    const doc = new Doc(); const host = new Node("div", doc)
    let refreshes = 0
    const attached: (SlotElement | null)[] = []
    const contribution = serversPanel({
      document: doc, anchor: "dock.inline-end", expanded: false,
      attach: (l) => attached.push(l), refresh: () => { refreshes += 1 },
      open: () => {}, onExpand: () => {}, onClose: () => {},
    })
    expect(contribution.id).toBe(SERVERS_PANEL_ID)
    const teardown = contribution.mount(host, bind)
    // لوحةٌ تنتظر الدورةَ التالية تُري المشغّل حالةً عمرُها دقيقة وتسمّيها حاضرة.
    expect(refreshes).toBe(1)
    expect(attached.length).toBe(1)
    expect(attached[0]).not.toBeNull()
    ;(teardown as () => void)()
    expect(attached[1]).toBeNull()
  })

  test("لا يعتمد على `children` — خاصّيةٌ لا يُعلنها العقد، وغيابُها يراكم بصمت", () => {
    // العطلُ الذي أُغلق: قراءةُ `list.children` تسلّلٌ خارج `SlotElement`.
    // على تطبيقٍ لا يحملها تصير `undefined`، فلا يُنزع شيء و**تتراكم الصفوف
    // بلا خطأ**. البديلُ هنا يُنفّذ العقدَ المُعلَن **وحده**: لا خاصّيةَ
    // `children` عليه إطلاقاً، ومخزنُه باسمٍ آخر لا يمكن أن يُصادفه الكود.
    class Minimal implements SlotElement {
      readonly kept: SlotElement[] = []
      className?: string
      id?: string
      textContent?: string | null
      get ownerDocument(): SlotDocument { return doc }
      setAttribute(): void {}
      appendChild(node: SlotElement): unknown { this.kept.push(node); return node }
      insertBefore(node: SlotElement): unknown { this.kept.push(node); return node }
      removeChild(node: SlotElement): unknown {
        const at = this.kept.indexOf(node)
        if (at < 0) throw new Error("removeChild: ليست ابناً")
        this.kept.splice(at, 1); return node
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    const doc = new Doc()
    const list = new Minimal()
    expect("children" in list).toBe(false)
    const rows: ServerRow[] = [{ name: "a", port: 1, state: "up" }, { name: "b", port: 2, state: "up" }]
    renderServers(doc, list, rows, () => {}, bind)
    expect(list.kept.length).toBe(2)
    // القياسُ الثاني يستبدل ولا يتراكم — وهذا هو ما كان يسقط صامتاً.
    renderServers(doc, list, rows, () => {}, bind)
    expect(list.kept.length).toBe(2)
    renderServers(doc, list, [], () => {}, bind)
    expect(list.kept.length).toBe(1)
  })
})
