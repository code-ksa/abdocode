import { describe, expect, test } from "bun:test"
import { renderTasks, tasksPanel, TASKS_PANEL_ID, type TaskRow } from "../src/shells/tasks-panel"
import type { Bind, SlotDocument, SlotElement } from "../src/shells/slot-host"

class Node implements SlotElement {
  readonly kids: SlotElement[] = []
  readonly attrs = new Map<string, string>()
  readonly listeners: { type: string; handler: (e: never) => void }[] = []
  id?: string
  className?: string
  hidden?: boolean
  textContent?: string | null
  type?: string
  value?: string
  constructor(readonly tag: string, readonly doc: Doc) {}
  get ownerDocument(): SlotDocument { return this.doc }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v) }
  appendChild(n: SlotElement): unknown { this.kids.push(n); return n }
  insertBefore(n: SlotElement): unknown { this.kids.push(n); return n }
  removeChild(n: SlotElement): unknown {
    const at = this.kids.indexOf(n)
    if (at < 0) throw new Error("removeChild: ليست ابناً")
    this.kids.splice(at, 1); return n
  }
  addEventListener(t: string, h: (e: never) => void): void { this.listeners.push({ type: t, handler: h }) }
  removeEventListener(t: string, h: (e: never) => void): void {
    const at = this.listeners.findIndex((l) => l.type === t && l.handler === h)
    if (at < 0) throw new Error("removeEventListener: لم يُعلَّق")
    this.listeners.splice(at, 1)
  }
  walk(): Node[] { return [this, ...this.kids.flatMap((c) => (c as Node).walk())] }
  text(): string { return this.walk().map((n) => n.textContent ?? "").join(" ") }
}
class Doc implements SlotDocument { createElement(tag: string): SlotElement { return new Node(tag, this) } }
const bind: Bind = (t, ty, h) => (t as Node).addEventListener(ty, h)

describe("لوحُ المهامّ — ما يجري الآن بأطواره", () => {
  test("الجاري يُفرَّق عن المنتهي بحكمٍ لا بزمن", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    const rows: TaskRow[] = [
      { turnId: "t1", title: "ابنِ الموقع", state: "running", epochs: 2, tools: 5, failed: 0 },
      { turnId: "t2", title: "شغّل الاختبارات", state: "completed", epochs: 1, tools: 3, failed: 0, duration: "12.4s" },
      { turnId: "t3", title: "انشر", state: "interrupted", epochs: 1, tools: 1, failed: 1 },
    ]
    renderTasks(doc, list, rows)
    expect(list.kids.length).toBe(3)
    expect(list.text()).toContain("يجري")
    expect(list.text()).toContain("تمّ · 12.4s")
    expect(list.text()).toContain("قوطع")
    expect((list.kids as Node[]).map((k) => k.className)).toEqual(["task-row task-running", "task-row task-completed", "task-row task-interrupted"])
  })

  test("الفشلُ يُعدّ ويُقال — «٣ أدوات» تخفي أنّ اثنتين سقطتا", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    renderTasks(doc, list, [{ turnId: "t", title: "x", state: "completed", epochs: 1, tools: 3, failed: 2 }])
    expect(list.text()).toContain("3 أداة")
    expect(list.text()).toContain("2 سقطت")
    // وبلا سقوطٍ لا تُذكر صفرٌ — عدّادٌ صفريٌّ ضجيجٌ يُتعلَّم تجاهلُه.
    const clean = new Node("div", doc)
    renderTasks(doc, clean, [{ turnId: "t", title: "x", state: "completed", epochs: 1, tools: 3, failed: 0 }])
    expect(clean.text()).not.toContain("سقطت")
  })

  test("الغيابُ يُقال باسمه، والرسمُ من البيانات كلَّ مرّة", () => {
    const doc = new Doc(); const list = new Node("div", doc)
    renderTasks(doc, list, [])
    expect(list.text()).toContain("لا مهمّةَ جارية")
    renderTasks(doc, list, [{ turnId: "a", title: "أ", state: "running", epochs: 1, tools: 1, failed: 0 }])
    expect(list.kids.length).toBe(1)
    renderTasks(doc, list, [])
    expect(list.kids.length).toBe(1)
    expect(list.text()).toContain("لا مهمّةَ جارية")
  })

  test("المساهمةُ تُعلن مِرساتها ومالكها، والفكُّ يقطع الوصل", () => {
    const doc = new Doc(); const host = new Node("div", doc)
    const attached: (SlotElement | null)[] = []
    const c = tasksPanel({ document: doc, anchor: "dock.inline-end", expanded: false, attach: (l) => attached.push(l), onExpand: () => {}, onClose: () => {} })
    expect(c.id).toBe(TASKS_PANEL_ID)
    expect(c.feature).toBe("tasksPanel")
    const teardown = c.mount(host, bind)
    expect(attached[0]).not.toBeNull()
    ;(teardown as () => void)()
    expect(attached[1]).toBeNull()
  })
})

test("task cards expose measured command output in nested disclosures", () => {
  const doc=new Doc(),list=new Node("div",doc)
  renderTasks(doc,list,[{turnId:"t",title:"Build",state:"running",epochs:1,tools:1,failed:0,steps:[{cmd:"npm run build",state:"✓",output:"<script>not markup</script>"}]}],"en")
  const nodes=list.walk()
  expect(nodes.filter(n=>n.tag==="details")).toHaveLength(2)
  expect(nodes.some(n=>n.tag==="summary"&&n.textContent==="✓ npm run build")).toBe(true)
  expect(nodes.find(n=>n.tag==="pre")?.textContent).toBe("<script>not markup</script>")
  expect(list.text()).toContain("running")
})

test("running task badge updates while panel is closed and opens it without toggling closed", async () => {
  const {readFileSync}=await import("node:fs"),{runInNewContext}=await import("node:vm")
  const html=readFileSync(new URL("../../desktop/ui/index.html",import.meta.url),"utf8")
  const code=html.slice(html.indexOf("    const taskActivity ="),html.indexOf("    const openTasks ="))
  let chip:any,opened=false,opens=0
  const turn:any={body:"Build",epochs:[{tools:[{cmd:"run build",glyph:"·"}]}]}
  const ctx:any={modeByTurn:new Map(),agentsByTurn:new Map(),WORK_MODE_LABEL:{basic:"basic"},runtimeSettings:{workMode:"basic"},working:1,pendingSubmissionEnvelope:{turn:{id:"t"}},document:{createElement:()=>({})},el:()=>({after:(n:any)=>chip=n}),TasksPanel:{renderTasks(){}},taskRows:null,Trajectory:{turns:()=>["t"],rows:()=>turn},trajStore:{},uiText:(en:string)=>en,shellSettings:{language:"en"},slots:{has:()=>opened},openTasks:()=>{opened=true;opens++}}
  runInNewContext(code+";globalThis.refresh=renderTaskRows",ctx)
  ctx.refresh();expect(chip.hidden).toBe(false);expect(chip.textContent).toBe("1 running tasks")
  chip.onclick();chip.onclick();expect(opens).toBe(1)
  turn.outcome="completed";ctx.refresh();expect(chip.textContent).toBe("1 tasks in history")
  delete turn.outcome;ctx.working=undefined;ctx.refresh();expect(chip.textContent).toBe("1 tasks in history")
})

test("السربُ ووضعُ العمل يُرسمان من الصفّ وحده: مربّعٌ لكلّ وكيل بحالته، ولا شريطَ بلا وكلاء", () => {
  const doc = new Doc(); const list = new Node("div", doc)
  renderTasks(doc, list, [{ turnId: "t", title: "x", state: "running", epochs: 2, tools: 4, failed: 0, mode: "أقصى", agents: [
    { id: "a1", name: "reviewer", task: "راجع الأمان", kind: "team", state: "running", epoch: 2 },
    { id: "a2", name: "tester", task: "شغّل الاختبارات", kind: "team", state: "complete", epoch: 3, detail: "5 أداة · 3 حقبة" },
    { id: "a3", name: "writer", task: "اكتب الوثيقة", kind: "delegate", state: "failed", detail: "انقطع" },
  ] }])
  const row = list.kids[0] as Node
  expect(row.text()).toContain("وضع «أقصى»")
  const strip = row.kids.find((k) => (k as Node).className === "task-agents") as Node
  expect(strip).toBeDefined()
  expect(strip.kids.length).toBe(3)
  const chips = strip.kids.map((w) => (w as Node).kids[0] as Node)
  expect(chips.map((c) => c.attrs.get("data-state"))).toEqual(["running", "complete", "failed"])
  expect(chips.map((c) => c.attrs.get("data-kind"))).toEqual(["team", "team", "delegate"])
  expect(chips.every((c) => (c.kids[0] as Node).className === "task-agent-dot")).toBe(true)
  expect(chips[0]!.text()).toContain("reviewer · 2")
  expect(chips[1]!.text()).toContain("tester")
  expect(chips[1]!.text()).not.toContain("· 3")
  const details = strip.kids.map((w) => (w as Node).kids[1] as Node)
  expect(details[0]!.textContent).toContain("فريق · يعمل")
  expect(details[1]!.textContent).toContain("أتمّ")
  expect(details[1]!.textContent).toContain("5 أداة · 3 حقبة")
  expect(details[2]!.textContent).toContain("تفويض · تعثّر")
  // بلا وكلاء لا شريط، وبلا وضعٍ لا ذكرَ له — الغيابُ لا يُرسم.
  const bare = new Node("div", doc)
  renderTasks(doc, bare, [{ turnId: "t", title: "x", state: "completed", epochs: 1, tools: 1, failed: 0 }])
  expect((bare.kids[0] as Node).kids.some((k) => (k as Node).className === "task-agents")).toBe(false)
  expect(bare.text()).not.toContain("وضع")
  const en = new Node("div", doc)
  renderTasks(doc, en, [{ turnId: "t", title: "x", state: "running", epochs: 1, tools: 1, failed: 0, mode: "أقصى", agents: [{ id: "a", name: "r", task: "t", kind: "team", state: "running" }] }], "en")
  expect(en.text()).toContain("mode max")
  expect(en.text()).toContain("team · running")
})
