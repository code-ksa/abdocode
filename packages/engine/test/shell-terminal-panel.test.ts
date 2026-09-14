import { describe, expect, test } from "bun:test"
import { terminalPanel, TERMINAL_PANEL_ID } from "../src/shells/terminal-panel"
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
  find(cls: string): Node[] { return this.walk().filter((n) => n.className === cls) }
  text(): string { return this.walk().map((n) => n.textContent ?? "").join(" ") }
}
class Doc implements SlotDocument { createElement(tag: string): SlotElement { return new Node(tag, this) } }

const harness = () => {
  const doc = new Doc()
  const host = new Node("div", doc)
  const bound: { target: Node; type: string; handler: (e: never) => void }[] = []
  const bind: Bind = (t, ty, h) => { (t as Node).addEventListener(ty, h); bound.push({ target: t as Node, type: ty, handler: h }) }
  const submitted: string[] = []
  const attached: (SlotElement | null)[] = []
  const contribution = terminalPanel({
    document: doc, anchor: "dock.block-end", expanded: false,
    attach: (l) => attached.push(l), submit: (c) => submitted.push(c),
    onExpand: () => {}, onClose: () => {},
  })
  const teardown = contribution.mount(host, bind)
  const input = host.walk().find((n) => n.className === "panel-input")!
  return { doc, host, bind, bound, submitted, attached, teardown, input, contribution }
}

describe("لوحُ الطرفيّة — إيصالاتٌ بصدقها ولا بابَ حول الموافقة", () => {
  test("الأمرُ يُسلَّم إلى المسار المثبَّت — لا تنفيذَ من اللوح", () => {
    const h = harness()
    h.input.value = "  npm run build  "
    // الفعلُ الخاصّ في الترويسة هو الإرسال.
    const send = h.host.find("iconbtn")[0]!
    send.listeners[0]!.handler(undefined as never)
    // نصٌّ مقصوصٌ يُسلَّم كما هو إلى `submit`، والقشرةُ هي التي تسبقه بـ`run `
    // عبر المُوزِّع فبوّابةِ النمط. لا استدعاءَ تنفيذٍ ثانٍ هنا بحال.
    expect(h.submitted).toEqual(["npm run build"])
    expect(h.input.value).toBe("")
  })

  test("Enter يرسل، وأمرٌ فارغٌ لا يُرسل شيئاً", () => {
    const h = harness()
    const keydown = h.bound.find((b) => b.type === "keydown")!
    h.input.value = "   "
    keydown.handler({ key: "Enter" } as never)
    expect(h.submitted).toEqual([])
    h.input.value = "git status"
    keydown.handler({ key: "Enter" } as never)
    expect(h.submitted).toEqual(["git status"])
    // ومفتاحٌ آخر لا يرسل — وإلا أرسل كلُّ حرفٍ أمراً.
    h.input.value = "x"
    keydown.handler({ key: "a" } as never)
    expect(h.submitted).toEqual(["git status"])
  })

  test("الغيابُ يُقال باسمه: «لم يُنفَّذ أمرٌ بعد» لا فراغٌ يُقرأ عطلاً", () => {
    const h = harness()
    expect(h.host.text()).toContain("لم يُنفَّذ أمرٌ في هذه الجلسة بعد")
  })

  test("الوصلُ يُسلَّم عند التركيب ويُقطع **قبل** الهدم", () => {
    const h = harness()
    expect(h.attached.length).toBe(1)
    expect((h.attached[0] as Node).id).toBe("terminalrows")
    ;(h.teardown as () => void)()
    // قشرةٌ ترسم في عقدةٍ نُزعت تكتب في العدم بلا خطأ، فيبدو اللوحُ مفتوحاً
    // ولا يتحدّث. قطعُ الوصل أوّلاً هو ما يمنع ذلك.
    expect(h.attached[1]).toBeNull()
  })

  test("المساهمةُ تُعلن مِرساتها ومالكها — فيفكّها إطفاءُ المفتاح", () => {
    const h = harness()
    expect(h.contribution.id).toBe(TERMINAL_PANEL_ID)
    expect(h.contribution.anchor).toBe("dock.block-end")
    expect(h.contribution.feature).toBe("terminalPanel")
  })

  test("كلُّ مستمعٍ يمرّ بـbind — فلا يبقى معلّقاً بعد الفكّ", () => {
    const h = harness()
    // لو عُلِّق مستمعٌ رأساً (خارج bind) لما نزعه المُحوِّل، ولبقي حيّاً على
    // عقدةٍ محذوفة. العدُّ هنا يقيس أن كلَّ ما عُلِّق مرّ بالسكّة الواحدة.
    const attachedListeners = h.host.walk().reduce((n, node) => n + node.listeners.length, 0)
    expect(attachedListeners).toBe(h.bound.length)
    expect(h.bound.length).toBeGreaterThanOrEqual(4)
  })
})
