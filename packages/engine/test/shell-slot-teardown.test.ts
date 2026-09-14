import { describe, expect, test } from "bun:test"
import { SlotHost, type SlotContribution, type SlotElement } from "../src/shells/slot-host"
import { ApprovalMount } from "../src/shells/approval-mount"
import { TrajectoryMount } from "../src/shells/trajectory-mount"
import { DeliverablesMount } from "../src/shells/deliverables-mount"

/**
 * IDEA 6 — برهانُ الفكّ، قياساً لا وصفاً.
 *
 * لا متصفّح في بوّابتنا ولا اعتماد DOM (وإضافةُ واحدٍ لأجل اختبارٍ سلسلةُ
 * توريدٍ جديدة). فالقياس يجري على **بديلٍ صارم**: كلُّ عقدةٍ تُحصى، وكلُّ
 * مستمعٍ يُحصى، ونزعُ مستمعٍ لم يُعلَّق أو حذفُ عقدةٍ ليست ابناً **يرمي** —
 * فالبديل لا يمرّر تفكيكاً كاذباً. وحدُّه معلَنٌ بصدق: يُثبت أنّ المُحوِّل
 * يحذف ما ركّبه وينزع ما علّقه، لا أنّ متصفّحاً حقيقياً يرسم كما نظنّ.
 *
 * ثلاثةُ قياسات لكلّ ميزة: قبل التركيب، بعده، وبعد الفكّ — والثالث يجب أن
 * يطابق الأوّل **حرفاً بحرف** (تسلسلُ الشجرة كلّها، لا المِرساة وحدها، لأن
 * الميزات تلمس عقداً خارج غلافها).
 */

// ── بديل الشجرة ────────────────────────────────────────────────────────────

interface Listener {
  readonly type: string
  readonly handler: (event: never) => void
}

class FakeDocument {
  createElement(tag: string): FakeNode {
    return new FakeNode(tag, this)
  }
}

class FakeNode {
  readonly children: FakeNode[] = []
  readonly attrs = new Map<string, string>()
  readonly listeners: Listener[] = []
  readonly classes: string[] = []
  parent: FakeNode | null = null
  id?: string
  className?: string
  hidden?: boolean
  textContent?: string | null
  type?: string
  value?: string

  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}

  readonly classList = {
    add: (name: string) => {
      if (!this.classes.includes(name)) this.classes.push(name)
    },
    remove: (name: string) => {
      const index = this.classes.indexOf(name)
      if (index >= 0) this.classes.splice(index, 1)
    },
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  appendChild(node: SlotElement): unknown {
    const child = node as unknown as FakeNode
    if (child === this || child.contains(asElement(this))) throw new Error("HierarchyRequestError")
    child.parent?.removeChild(node)
    child.parent = this
    this.children.push(child)
    return child
  }

  insertBefore(node: SlotElement, before: SlotElement | null): unknown {
    const child = node as unknown as FakeNode
    if (child === this || child.contains(asElement(this))) throw new Error("HierarchyRequestError")
    if (before !== null && !this.children.includes(before as unknown as FakeNode)) throw new Error("NotFoundError")
    child.parent?.removeChild(node)
    child.parent = this
    const index = before === null ? -1 : this.children.indexOf(before as unknown as FakeNode)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  contains(node: SlotElement): boolean {
    return node === asElement(this) || this.children.some((child) => child.contains(node))
  }

  // حذفُ ما ليس ابناً يرمي: لا «فكّ» يمرّ لأن المُحوِّل نسي أين علّق.
  removeChild(node: SlotElement): unknown {
    const child = node as unknown as FakeNode
    const index = this.children.indexOf(child)
    if (index < 0) throw new Error(`removeChild: ${child.tag} is not a child of ${this.tag}`)
    this.children.splice(index, 1)
    child.parent = null
    return child
  }

  addEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.push({ type, handler })
  }

  // نزعُ مستمعٍ لم يُعلَّق يرمي — وإلّا مرّ «نزعٌ» لم يقع.
  removeEventListener(type: string, handler: (event: never) => void): void {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.handler === handler)
    if (index < 0) throw new Error(`removeEventListener: no ${type} listener on ${this.tag}`)
    this.listeners.splice(index, 1)
  }
}

const asElement = (node: FakeNode): SlotElement => node as unknown as SlotElement

/** تسلسلٌ حتميّ: كلّ ما يمكن أن يتغيّر يظهر فيه، ومنه يقاس «حرفاً بحرف». */
const serialize = (node: FakeNode): string => {
  const bits = [node.tag]
  if (node.id !== undefined) bits.push(`#${node.id}`)
  if (node.className !== undefined) bits.push(`.${node.className}`)
  if (node.classes.length > 0) bits.push(`[class=${node.classes.join(" ")}]`)
  // كلُّ قيمةٍ غير `undefined` تظهر — لا `true` وحدها: «لم يُلمس» و«أُعيد إلى
  // `false`» كانا يتسلسلان سواءً، فيمرّ ردٌّ إلى قيمةٍ مكتوبةٍ بيد على أنّه
  // «مطابقٌ حرفاً بحرف».
  if (node.hidden !== undefined) bits.push(`[hidden=${node.hidden}]`)
  if (node.type !== undefined) bits.push(`[type=${node.type}]`)
  for (const [name, value] of [...node.attrs].sort()) bits.push(`[${name}=${value}]`)
  if (node.textContent !== undefined && node.textContent !== null) bits.push(`"${node.textContent}"`)
  if (node.listeners.length > 0) bits.push(`<listeners:${node.listeners.map((l) => l.type).sort().join(",")}>`)
  const inner = node.children.map(serialize).join("")
  return `(${bits.join("")}${inner})`
}

const countNodes = (node: FakeNode): number =>
  1 + node.children.reduce((total, child) => total + countNodes(child), 0)

const countListeners = (node: FakeNode): number =>
  node.listeners.length + node.children.reduce((total, child) => total + countListeners(child), 0)

// ── قشرةٌ صغيرة بمراسيها الخمس، كما في `index.html` ────────────────────────

interface Shell {
  readonly document: FakeDocument
  readonly root: FakeNode
  readonly host: SlotHost
  readonly anchors: Record<string, FakeNode>
  readonly composer: FakeNode
  readonly chatTab: FakeNode
  readonly feed: FakeNode
  readonly outputsSection: FakeNode
}

const shell = (): Shell => {
  const document = new FakeDocument()
  const root = document.createElement("body")
  const make = (tag: string, id?: string): FakeNode => {
    const node = document.createElement(tag)
    if (id !== undefined) node.id = id
    return node
  }

  const tabs = make("div", "tabs")
  const chatTab = make("button", "chattab")
  chatTab.textContent = "محادثة"
  chatTab.classList.add("active")
  const tabAnchor = make("span", "slot-tab-strip")
  tabAnchor.setAttribute("data-anchor", "tab.strip")
  tabs.appendChild(asElement(chatTab))
  tabs.appendChild(asElement(tabAnchor))

  const feed = make("div", "feed")
  const transcriptAnchor = make("div", "slot-transcript-node")
  transcriptAnchor.setAttribute("data-anchor", "transcript.node")

  const composer = make("div", "composer")
  const composerAnchor = make("div", "slot-composer-bar")
  composerAnchor.setAttribute("data-anchor", "composer.bar")
  composer.appendChild(asElement(composerAnchor))

  const activity = make("section", "activity")
  const activityAnchor = make("div", "slot-activity-section")
  activityAnchor.setAttribute("data-anchor", "activity.section")
  const outputsSection = make("div", "actoutputssect")
  outputsSection.className = "act-sect"
  activity.appendChild(asElement(activityAnchor))
  activity.appendChild(asElement(outputsSection))

  const settings = make("div", "pluginspanel")
  const settingsAnchor = make("div", "slot-settings-section")
  settingsAnchor.setAttribute("data-anchor", "settings.section")
  settings.appendChild(asElement(settingsAnchor))

  root.appendChild(asElement(tabs))
  root.appendChild(asElement(feed))
  root.appendChild(asElement(transcriptAnchor))
  root.appendChild(asElement(composer))
  root.appendChild(asElement(activity))
  root.appendChild(asElement(settings))

  const anchors: Record<string, FakeNode> = {
    "composer.bar": composerAnchor,
    "transcript.node": transcriptAnchor,
    "tab.strip": tabAnchor,
    "settings.section": settingsAnchor,
    "activity.section": activityAnchor,
  }
  const host = new SlotHost((name) => (anchors[name] === undefined ? null : asElement(anchors[name]!)))
  return { document, root, host, anchors, composer, chatTab, feed, outputsSection }
}

interface Sink {
  node: FakeNode | null
}

const approvalContribution = (env: Shell, sink: Sink, clicks: string[]): SlotContribution =>
  ApprovalMount.seat({
    document: env.document,
    act: (choice) => clicks.push(choice),
    reveal: () => clicks.push("reveal"),
    composer: env.composer,
    attach: (node) => {
      sink.node = node as unknown as FakeNode | null
    },
  })

const trajectoryContributions = (env: Shell, tab: Sink, view: Sink, log: string[]): SlotContribution[] => {
  // القشرة تقيس ما ستردّه **قبل** التركيب — كما تفعل `index.html`. ردٌّ إلى
  // `false` مكتوبةٍ بيد كان يكشف محادثةً وجدها اللسانُ مخفيّة.
  const feedHidden = env.feed.hidden
  const chatWasActive = env.chatTab.classes.includes("active")
  return [
    TrajectoryMount.tab({
      document: env.document,
      toggle: () => log.push("toggle"),
      chatTab: asElement(env.chatTab),
      showChat: () => log.push("show-chat"),
      attach: (node) => {
        tab.node = node as unknown as FakeNode | null
      },
    }),
    TrajectoryMount.view({
      document: env.document,
      pick: (turnId) => log.push(`pick:${turnId}`),
      attach: (node) => {
        view.node = node as unknown as FakeNode | null
      },
      restoreChat: () => {
        log.push("restore-chat")
        env.feed.hidden = feedHidden
        if (chatWasActive) env.chatTab.classList.add("active")
        else env.chatTab.classList.remove("active")
      },
    }),
  ]
}

const deliverablesContribution = (env: Shell, sink: Sink): SlotContribution =>
  DeliverablesMount.row({
    document: env.document,
    generalSection: asElement(env.outputsSection),
    attach: (node) => {
      sink.node = node as unknown as FakeNode | null
    },
  })

// ── البرهان ───────────────────────────────────────────────────────────────

describe("slot host — teardown measured, not asserted", () => {
  test("the approval seat mounts into composer.bar and leaves it byte-identical when torn down", () => {
    const env = shell()
    const sink: Sink = { node: null }
    const clicks: string[] = []

    const before = { html: serialize(env.root), nodes: countNodes(env.root), listeners: countListeners(env.root) }
    expect(before.listeners).toBe(0)

    expect(env.host.register(approvalContribution(env, sink, clicks))).toBeUndefined()
    const mounted = { nodes: countNodes(env.root), listeners: countListeners(env.root) }
    expect(mounted.nodes - before.nodes).toBe(9) // الغلاف + المقعد + 3 + 4
    expect(mounted.listeners).toBe(3) // ✓ · ✕ · المعاينة
    expect(env.host.liveListeners()).toBe(3)
    expect(sink.node!.id).toBe("approvalseat")
    expect(serialize(env.anchors["composer.bar"]!)).toContain("#approvalseat")
    // الاستيلاء يضع صنفاً على المؤلِّف — عقدةٌ خارج الغلاف، ودليلُ الفكّ الحقيقي.
    env.composer.classList.add("approving")

    expect(env.host.unregister(ApprovalMount.SEAT_ID)).toBeUndefined()
    expect(serialize(env.root)).toBe(before.html)
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(countListeners(env.root)).toBe(0)
    expect(env.host.liveListeners()).toBe(0)
    expect(env.host.mounted()).toEqual([])
    expect(sink.node).toBeNull()
    expect(env.composer.classes).toEqual([])
  })

  test("the trajectory tab and view are ONE feature in TWO anchors — and the chat-tab listener it borrowed is taken back", () => {
    const env = shell()
    const tab: Sink = { node: null }
    const view: Sink = { node: null }
    const log: string[] = []

    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    for (const contribution of trajectoryContributions(env, tab, view, log)) {
      expect(env.host.register(contribution)).toBeUndefined()
    }
    expect(env.host.mounted("trajectory")).toEqual([TrajectoryMount.TAB_ID, TrajectoryMount.VIEW_ID])
    // المستمع المستعار: على لسان المحادثة، عقدةٍ لا تملكها الميزة ولا تُحذف معها.
    expect(env.chatTab.listeners).toHaveLength(1)
    expect(countListeners(env.root)).toBe(3) // lسان + لسان المحادثة + منتقي الدور
    expect(tab.node!.id).toBe("trajtab")
    expect(view.node!.id).toBe("trajectory")

    // المنظر معروض لحظةَ الإطفاء: المحادثة مخفيّة ولسانها غير نشط.
    view.node!.hidden = false
    env.feed.hidden = true
    env.chatTab.classList.remove("active")

    expect(env.host.unregisterFeature("trajectory")).toEqual([])
    expect(serialize(env.root)).toBe(before.html)
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(env.chatTab.listeners).toHaveLength(0)
    expect(countListeners(env.root)).toBe(0)
    // ما رُدّ هو **المقيس** قبل التركيب (`undefined`) لا `false` مكتوبة بيد.
    expect(env.feed.hidden).toBeUndefined()
    expect(env.chatTab.classes).toEqual(["active"])
    expect(log).toContain("restore-chat")
    expect(tab.node).toBeNull()
    expect(view.node).toBeNull()
  })

  test("a trajectory view that is NOT the displayed one gives the chat back nothing — it took nothing", () => {
    const env = shell()
    const tab: Sink = { node: null }
    const view: Sink = { node: null }
    const log: string[] = []

    // المشغّل يخفي المحادثة لسببٍ آخر (لوحةٌ جانبية مثلاً) واللسان مطفأ:
    // فكُّ المنظر المخفيّ لا يحقّ له كشفها.
    env.feed.hidden = true
    env.chatTab.classList.remove("active")
    for (const contribution of trajectoryContributions(env, tab, view, log)) {
      expect(env.host.register(contribution)).toBeUndefined()
    }
    expect(view.node!.hidden).toBe(true)

    expect(env.host.unregisterFeature("trajectory")).toEqual([])
    expect(log).not.toContain("restore-chat")
    expect(env.feed.hidden).toBe(true)
    expect(env.chatTab.classes).toEqual([])
  })

  test("the deliverables row hides the general outputs section and gives it back on teardown", () => {
    const env = shell()
    const sink: Sink = { node: null }
    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    expect(env.outputsSection.hidden).toBeUndefined()

    expect(env.host.register(deliverablesContribution(env, sink))).toBeUndefined()
    expect(env.outputsSection.hidden).toBe(true)
    expect(sink.node!.id).toBe("delivrows")
    expect(countNodes(env.root) - before.nodes).toBe(5) // الغلاف + القسم + العنوان + القائمة + «لا مسلَّمات»

    expect(env.host.unregister(DeliverablesMount.ROW_ID)).toBeUndefined()
    // «يُردّ» تعني إلى المقيس قبل التركيب — و`undefined` ليست `false`.
    expect(env.outputsSection.hidden).toBeUndefined()
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(sink.node).toBeNull()
    expect(serialize(env.root)).toBe(before.html)
  })

  test("a general outputs section the row found ALREADY hidden is given back hidden, not un-hidden", () => {
    const env = shell()
    const sink: Sink = { node: null }
    // المشغّل أخفاه قبل أن تُشعل الميزة: الفكّ يردّ ما وجد لا ما يفترض.
    env.outputsSection.hidden = true
    const before = serialize(env.root)

    expect(env.host.register(deliverablesContribution(env, sink))).toBeUndefined()
    expect(env.outputsSection.hidden).toBe(true)
    expect(env.host.unregister(DeliverablesMount.ROW_ID)).toBeUndefined()
    expect(env.outputsSection.hidden).toBe(true)
    expect(serialize(env.root)).toBe(before)
  })

  test("mounting and unmounting all three, five times over, accumulates nothing", () => {
    const env = shell()
    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    const sink: Sink = { node: null }
    const tab: Sink = { node: null }
    const view: Sink = { node: null }
    const rows: Sink = { node: null }
    const log: string[] = []

    for (let round = 0; round < 5; round++) {
      expect(env.host.register(approvalContribution(env, sink, log))).toBeUndefined()
      for (const contribution of trajectoryContributions(env, tab, view, log)) {
        expect(env.host.register(contribution)).toBeUndefined()
      }
      expect(env.host.register(deliverablesContribution(env, rows))).toBeUndefined()
      expect(env.host.mounted()).toHaveLength(4)
      env.composer.classList.add("approving")

      env.host.unregisterFeature("approvalTakeover")
      env.host.unregisterFeature("trajectory")
      env.host.unregisterFeature("deliverables")
      expect(env.host.mounted()).toEqual([])
      expect(env.host.liveListeners()).toBe(0)
      expect(countListeners(env.root)).toBe(0)
      expect(countNodes(env.root)).toBe(before.nodes)
      // الجولةُ الخامسة تطابق ما قبل الأولى — لا تراكمَ عقدةٍ ولا مستمع.
      expect({ round, html: serialize(env.root) }).toEqual({ round, html: before.html })
    }
    expect(env.outputsSection.hidden).toBeUndefined()
    expect(env.composer.classes).toEqual([])
    expect(env.chatTab.classes).toEqual(["active"])
  })

  test("the DOM order follows the registry's order, not the order of the register() calls", () => {
    const env = shell()
    const build = (id: string, order: number): SlotContribution => ({
      id,
      anchor: "tab.strip",
      feature: id,
      order,
      mount: (host) => {
        const node = env.document.createElement("button")
        node.id = id
        host.appendChild(asElement(node))
      },
    })
    // تُسجَّل الأعلى رتبةً أوّلاً — ولو كان الترتيب ترتيبَ النداء لظهرت أوّلاً.
    expect(env.host.register(build("late", 20))).toBeUndefined()
    expect(env.host.register(build("early", 10))).toBeUndefined()
    const strip = env.anchors["tab.strip"]!
    expect(strip.children.map((wrapper) => wrapper.children[0]!.id)).toEqual(["early", "late"])
    expect(env.host.order("tab.strip")).toEqual(["early", "late"])
  })

  test("an unknown anchor, a missing anchor node and a duplicate id are all refused BY NAME", () => {
    const env = shell()
    const sink: Sink = { node: null }
    const seat = approvalContribution(env, sink, [])
    const bare = countNodes(env.root)
    expect(env.host.register({ ...seat, id: "x", anchor: "composer.side" })).toBe('مرساة غير معروفة: "composer.side"')
    expect(countNodes(env.root)).toBe(bare)

    const blind = new SlotHost(() => null)
    expect(blind.register(seat)).toBe('مرساة غير موجودة في القشرة: "composer.bar"')
    expect(blind.mounted()).toEqual([])

    expect(env.host.register(seat)).toBeUndefined()
    const nodes = countNodes(env.root)
    expect(env.host.register(approvalContribution(env, sink, []))).toBe(
      `تسجيل مكرّر لنقطة التعليق: "${ApprovalMount.SEAT_ID}"`,
    )
    // ورفضُ التكرار لا يبني شيئاً: لا شجرةَ يتيمة تُترك خلفه.
    expect(countNodes(env.root)).toBe(nodes)
    expect(env.host.mounted()).toEqual([ApprovalMount.SEAT_ID])
  })

  test("a mount that throws leaves nothing behind, and unregister is idempotent", () => {
    const env = shell()
    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    const refusal = env.host.register({
      id: "boom",
      anchor: "tab.strip",
      feature: "boom",
      mount: (host, bind) => {
        const node = env.document.createElement("button")
        bind(asElement(node), "click", () => undefined)
        host.appendChild(asElement(node))
        throw new Error("نصفُ تركيب")
      },
    })
    expect(refusal).toBe('تركيب "boom" سقط: نصفُ تركيب')
    expect(serialize(env.root)).toBe(before.html)
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(countListeners(env.root)).toBe(0)
    expect(env.host.mounted()).toEqual([])

    // الفكّ صامدٌ للتكرار حتى لمعرّفٍ لم يُركَّب قطّ.
    expect(env.host.unregister("boom")).toBeUndefined()
    expect(env.host.unregister("never")).toBeUndefined()
  })

  test("a feature teardown that throws is NAMED, and the structural teardown still completes", () => {
    const env = shell()
    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    expect(
      env.host.register({
        id: "bad",
        anchor: "tab.strip",
        feature: "bad",
        mount: (host, bind) => {
          const node = env.document.createElement("button")
          bind(asElement(node), "click", () => undefined)
          host.appendChild(asElement(node))
          return () => {
            throw new Error("مفكِّكٌ سقط")
          }
        },
      }),
    ).toBeUndefined()
    expect(env.host.unregister("bad")).toBe('مفكِّك "bad" سقط: مفكِّكٌ سقط')
    // ومع ذلك: لا عقدةٌ باقية، ولا مستمعٌ باقٍ.
    expect(serialize(env.root)).toBe(before.html)
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(countListeners(env.root)).toBe(0)
    expect(env.host.mounted()).toEqual([])
  })

  test("a contribution registered from INSIDE another's mount is in the registry — not an orphan its feature can never tear down", () => {
    const env = shell()
    const before = { html: serialize(env.root), nodes: countNodes(env.root) }
    const build = (id: string, order: number): SlotContribution => ({
      id,
      anchor: "composer.bar",
      feature: "f",
      order,
      mount: (host) => {
        const node = env.document.createElement("span")
        node.id = id
        host.appendChild(asElement(node))
      },
    })
    const inner = build("inner", 5)
    const outer: SlotContribution = {
      ...build("outer", 1),
      mount: (host) => {
        const node = env.document.createElement("span")
        node.id = "outer"
        host.appendChild(asElement(node))
        // تسجيلٌ من داخل التركيب: حين كانت الحالةُ تُكتب **بعد** `mount` كانت
        // المحسوبةُ قبله تدهس هذا — غلافٌ حيٌّ لا يراه السجلّ ولا يفكّه أحد.
        expect(env.host.register(inner)).toBeUndefined()
      },
    }

    expect(env.host.register(outer)).toBeUndefined()
    expect(env.host.has("inner")).toBe(true)
    expect(env.host.mounted("f")).toEqual(["outer", "inner"])
    expect(env.host.order("composer.bar")).toEqual(["outer", "inner"])
    expect(env.anchors["composer.bar"]!.children).toHaveLength(2)

    // وإطفاءُ المفتاح يفكّ الاثنتين: لا عقدةٌ تبقى بلا مقبض.
    expect(env.host.unregisterFeature("f")).toEqual([])
    expect(env.host.mounted()).toEqual([])
    expect(countNodes(env.root)).toBe(before.nodes)
    expect(serialize(env.root)).toBe(before.html)
  })

  test("one contribution whose structural removal throws is NAMED, its siblings still fall, and its handle survives for a retry", () => {
    const env = shell()
    const wrappers = new Map<string, FakeNode>()
    const build = (id: string, anchor: string): SlotContribution => ({
      id,
      anchor,
      feature: "f",
      order: 10,
      mount: (host, bind) => {
        wrappers.set(id, host as unknown as FakeNode)
        const node = env.document.createElement("button")
        node.id = id
        bind(asElement(node), "click", () => undefined)
        host.appendChild(asElement(node))
      },
    })
    expect(env.host.register(build("x1", "composer.bar"))).toBeUndefined()
    expect(env.host.register(build("x2", "transcript.node"))).toBeUndefined()

    // الغلاف زُحزح من تحت المُحوِّل: `removeChild` يرمي على الأولى وحدها.
    const anchor = env.anchors["composer.bar"]!
    anchor.children.length = 0
    wrappers.get("x1")!.parent = null

    const failures = env.host.unregisterFeature("f")
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('هدم "x1" سقط')
    // الأخت هُدمت رغم ذلك — لا نصفُ ميزةٍ باقٍ بلا مفتاح — والسجلّ فارغ.
    expect(env.host.mounted()).toEqual([])
    expect(env.anchors["transcript.node"]!.children).toHaveLength(0)
    expect(env.host.liveListeners()).toBe(0)

    // والقيدُ باقٍ فتُعاد المحاولة حين يعود الغلاف إلى مِرساته.
    anchor.appendChild(asElement(wrappers.get("x1")!))
    expect(env.host.unregister("x1")).toBeUndefined()
    expect(anchor.children).toHaveLength(0)
    expect(env.host.unregister("x1")).toBeUndefined()
  })

  test("physical relocation keeps feature ownership and listeners, then unregister removes from the new dock", () => {
    const env = shell()
    const target = env.document.createElement("section")
    env.root.appendChild(asElement(target))
    const before = serialize(env.root)
    let mounts = 0, teardowns = 0, clicks = 0
    expect(env.host.register({
      id: "panel:terminal", feature: "terminalPanel", anchor: "composer.bar",
      mount: (wrapper, bind) => {
        mounts++
        const button = env.document.createElement("button")
        bind(asElement(button), "click", () => { clicks++ })
        bind(asElement(env.chatTab), "click", () => { clicks++ })
        wrapper.appendChild(asElement(button))
        return () => { teardowns++ }
      },
    })).toBeUndefined()
    const wrapper = env.anchors["composer.bar"]!.children[0]!
    const button = wrapper.children[0]!
    expect(env.host.relocate("panel:terminal", asElement(target))).toBeUndefined()
    expect(env.anchors["composer.bar"]!.children).toHaveLength(0)
    expect(target.children).toEqual([wrapper])
    expect(env.host.order("composer.bar")).toEqual(["panel:terminal"])
    expect(env.host.mounted("terminalPanel")).toEqual(["panel:terminal"])
    expect(env.host.liveListeners()).toBe(2)
    button.listeners[0]!.handler(undefined as never)
    expect(clicks).toBe(1)
    expect(env.host.relocate("panel:terminal", asElement(target))).toBeUndefined()
    expect(mounts).toBe(1)
    expect(target.children).toHaveLength(1)
    expect(env.host.unregisterFeature("terminalPanel")).toEqual([])
    expect(teardowns).toBe(1)
    expect(env.host.liveListeners()).toBe(0)
    expect(serialize(env.root)).toBe(before)
  })

  test("relocation refuses absent ids, another document and descendant targets without changing the standing feature", () => {
    const env = shell()
    let wrapper: FakeNode | undefined
    const child = env.document.createElement("section")
    expect(env.host.register({ id: "live", feature: "feature", anchor: "composer.bar", mount: (host) => { wrapper = host as unknown as FakeNode; host.appendChild(asElement(child)) } })).toBeUndefined()
    const before = serialize(env.root)
    expect(env.host.relocate("absent", asElement(env.root))).toContain("غير مركّبة")
    expect(env.host.relocate("live", asElement(new FakeDocument().createElement("div")))).toContain("وثيقتين")
    expect(env.host.relocate("live", asElement(child))).toContain("داخل المساهمة")
    expect(env.host.relocate("live", asElement(wrapper!))).toContain("داخل المساهمة")
    expect(env.host.relocate("live", null as unknown as SlotElement)).toContain("غير صالحة")
    const invalid = env.document.createElement("div")
    invalid.appendChild = () => { throw new Error("HierarchyRequestError") }
    expect(env.host.relocate("live", asElement(invalid))).toContain("HierarchyRequestError")
    expect(serialize(env.root)).toBe(before)
    expect(env.host.mounted("feature")).toEqual(["live"])
    expect(env.host.unregister("live")).toBeUndefined()
  })

  test("registering an earlier logical peer after relocation never uses a node from a different physical parent", () => {
    const env = shell()
    const target = env.document.createElement("section")
    env.root.appendChild(asElement(target))
    const contribution = (id: string, order: number): SlotContribution => ({ id, feature: "feature", anchor: "composer.bar", order, mount: () => undefined })
    expect(env.host.register(contribution("later", 20))).toBeUndefined()
    expect(env.host.relocate("later", asElement(target))).toBeUndefined()
    expect(env.host.register(contribution("earlier", 10))).toBeUndefined()
    expect(env.host.order("composer.bar")).toEqual(["earlier", "later"])
    expect(env.anchors["composer.bar"]!.children).toHaveLength(1)
    expect(target.children).toHaveLength(1)
    expect(env.host.unregisterFeature("feature")).toEqual([])
    expect(env.anchors["composer.bar"]!.children).toHaveLength(0)
    expect(target.children).toHaveLength(0)
  })
})
