/**
 * لوحُ المهامّ — ما يجري الآن، بأطواره وأزمنته.
 *
 * العمودُ الثالث في مرجع المالك. وما يقابله عندنا ليس «مهامَّ خلفيّة» بمعنى
 * عمليّاتٍ مستقلّة، بل **الدورُ الجاري بحقبه وأدواته** — وهو ما نملك عنه
 * قياساً حقيقيّاً. تسميتُه بغير ذلك كانت ستَعِد بما لا يوجد.
 *
 * **ولا فولدَ ثانياً**: كلُّ صفٍّ هنا من فولد «المسار» القائم الذي يزوّج
 * `tool` بنتيجته ويحمل المدّةَ والحكم. فولدٌ ثانٍ للأُطر نفسها أغلى صنفِ عيبٍ
 * في هذا المستودع بشهادة جرده، وأوّلُ اختلافٍ بين الفولدين يجعل اللوحَ يناقض
 * المحادثة أمام المستخدم.
 *
 * **والجاري يُفرَّق عن المنتهي بحكمٍ لا بزمن**: دورٌ بلا `outcome` جارٍ،
 * ومَنْ له `outcome` منتهٍ. مؤقّتٌ يخمّن «طال فمات» يكذب على بناءٍ بطيء.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"
import { panelFrame } from "./panel-frame"

export const TASKS_PANEL_ID = "panel:tasks"

/** صفٌّ واحد — ما يعرفه فولدُ المسار، بلا حقلٍ يُشتقّ هنا. */
export interface TaskRow {
  readonly turnId: string
  readonly title: string
  /** `running` ما لم يصل حكمُ الدور — لا تخمينَ بالزمن. */
  readonly state: "running" | "completed" | "interrupted" | "unresolved" | "checkpointed"
  readonly epochs: number
  readonly tools: number
  readonly failed: number
  readonly steps?: readonly {readonly cmd:string;readonly output:string;readonly state:string}[]
  readonly duration?: string
  /** وضعُ العمل الذي يجري فيه الدور (أساسيّ/أقوى/أقوى+/أقصى) — يُقال باسمه، فالمستخدم يرى أيَّ سلّمٍ يُصعَد. */
  readonly mode?: string
  /** وكلاءُ الدور المفوَّضون (delegate) والمتوازون (team) — من إطار `agent` وحده، لا استنتاجَ هنا. */
  readonly agents?: readonly TaskAgent[]
}

/** وكيلٌ واحد كما أعلنه المحرّك: حالتُه حكمُ تقريره لا زمنُه؛ `running` ما لم يصل الحكم. */
export interface TaskAgent {
  readonly id: string
  readonly name: string
  readonly task: string
  readonly kind: "delegate" | "team"
  readonly state: "running" | "complete" | "budget" | "aborted" | "failed" | "stalled" | string
  readonly epoch?: number
  readonly detail?: string
}

/** أسماءُ الأوضاع تصل عربيّةً من المحرّك (work-mode.ts)؛ الواجهةُ الإنجليزيّة تترجمها ولا تخترع رابعاً. */
const MODE_EN: Readonly<Record<string, string>> = Object.freeze({ "أساسيّ": "basic", "أقوى": "stronger", "أقوى+": "stronger+", "أقصى": "max" })
const AGENT_STATE_AR: Readonly<Record<string, string>> = Object.freeze({
  running: "يعمل", complete: "أتمّ", budget: "نفدت الميزانية", aborted: "قوطع", failed: "تعثّر", stalled: "توقّف",
})

export interface TasksDeps {
  readonly document: SlotDocument
  readonly anchor: string
  readonly attach: (list: SlotElement | null) => void
  readonly onExpand: (next: boolean) => void
  readonly onClose: () => void
  readonly expanded: boolean
  readonly onPopout?: () => void
  readonly onDragStart?: (event: unknown) => void
  readonly onDragEnd?: () => void
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

const STATE_AR: Readonly<Record<TaskRow["state"], string>> = Object.freeze({
  running: "يجري",
  completed: "تمّ",
  interrupted: "قوطع",
  unresolved: "بلا تمام",
  checkpointed: "نقطة حفظ",
})

/** ما رسمناه في كلّ قائمة — يُنزع بالضبط ما وُضع، بلا سؤال الشجرة عن أبنائها. */
const rendered = new WeakMap<SlotElement, SlotElement[]>()

export const renderTasks = (
  document: SlotDocument,
  list: SlotElement,
  rows: readonly TaskRow[],
  language = "ar",
): void => {
  const expanded = new Set((rendered.get(list) ?? []).filter(n => (n as SlotElement & {open?:boolean}).open).map(n => n.id))
  for (const previous of rendered.get(list) ?? []) list.removeChild(previous)
  const mine: SlotElement[] = []
  rendered.set(list, mine)

  if (rows.length === 0) {
    const blank = make(document, "span", "act-empty")
    // الغيابُ يُقال باسمه: فراغٌ بلا كلمةٍ يُقرأ عطلاً في اللوح.
    blank.textContent = "لا مهمّةَ جارية"
    list.appendChild(blank)
    mine.push(blank)
    return
  }
  for (const row of [...rows].sort((a,b)=>Number(b.state==="running")-Number(a.state==="running"))) {
    const item = make(document, "details", `task-row task-${row.state}`)
    item.id="task-"+row.turnId
    if(expanded.has(item.id))item.setAttribute("open", "")
    const head = make(document, "summary", "task-head")
    const title = make(document, "span", "task-title")
    title.textContent = row.title
    const state = make(document, "span", "task-state")
    state.textContent = (language === "en" ? row.state : STATE_AR[row.state]) + (row.duration === undefined ? "" : ` · ${row.duration}`)
    head.appendChild(title)
    head.appendChild(state)

    const meta = make(document, "div", "task-meta")
    // الفشلُ يُعدّ ويُقال: «٣ أدوات» تخفي أنّ اثنتين منها سقطتا.
    meta.textContent = `${row.epochs} حقبة · ${row.tools} أداة` + (row.failed > 0 ? ` · ${row.failed} سقطت` : "")

    if(language==="en")meta.textContent=`${row.epochs} epochs · ${row.tools} tools`+(row.failed ? ` · ${row.failed} failed` : "")
    // وضعُ العمل يُقال باسمه على الصفّ: المستخدمُ يرى أيَّ سلّمٍ (أساسيّ/أقوى/أقوى+/أقصى) يصعده الدور.
    if(row.mode!==undefined&&row.mode.length>0)meta.textContent+=language==="en"?` · mode ${MODE_EN[row.mode]??row.mode}`:` · وضع «${row.mode}»`
    item.appendChild(head)
    item.appendChild(meta)
    // السرب: مربّعٌ تفاعليّ لكلّ وكيل (details أصليّ بلا مستمع)، ونقطةٌ زرقاء نابضة لمن يعمل — كما في مرجع المالك.
    if(row.agents!==undefined&&row.agents.length>0){
      const strip=make(document,"div","task-agents")
      for(const agent of row.agents){
        const wrap=make(document,"details","task-agent-wrap")
        wrap.id=`task-agent-${row.turnId}-${agent.id}`
        const chip=make(document,"summary","task-agent")
        chip.setAttribute("data-state",agent.state)
        chip.setAttribute("data-kind",agent.kind)
        chip.setAttribute("title",agent.task)
        const dot=make(document,"span","task-agent-dot")
        const name=make(document,"span","task-agent-name")
        name.textContent=agent.name+(agent.epoch!==undefined&&agent.state==="running"?` · ${agent.epoch}`:"")
        chip.appendChild(dot);chip.appendChild(name)
        const detail=make(document,"div","task-agent-detail")
        const stateText=language==="en"?agent.state:(AGENT_STATE_AR[agent.state]??agent.state)
        detail.textContent=`${agent.kind==="team"?(language==="en"?"team":"فريق"):(language==="en"?"delegate":"تفويض")} · ${stateText}\n${agent.task}`+(agent.detail?`\n${agent.detail}`:"")
        wrap.appendChild(chip);wrap.appendChild(detail);strip.appendChild(wrap)
      }
      item.appendChild(strip)
    }
    for(const step of row.steps||[]){
      const card=make(document,"details","task-step"),caption=make(document,"summary","task-step-title"),output=make(document,"pre","task-step-output")
      caption.textContent=step.state+" "+step.cmd;output.textContent=step.output;card.appendChild(caption);card.appendChild(output);item.appendChild(card)
    }
    list.appendChild(item)
    mine.push(item)
  }
}

export const tasksPanel = (deps: TasksDeps): SlotContribution => ({
  id: TASKS_PANEL_ID,
  anchor: deps.anchor,
  feature: "tasksPanel",
  order: 30,
  mount: (host, bind) => {
    const frame = panelFrame({
      document: deps.document,
      title: "المهامّ",
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      expanded: deps.expanded,
      ...(deps.onPopout === undefined ? {} : { onPopout: deps.onPopout }),
      ...(deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart }),
      ...(deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd }),
    }, host, bind)

    const list = make(deps.document, "div", "panel-list")
    list.id = "taskrows"
    renderTasks(deps.document, list, [])
    frame.body.appendChild(list)

    deps.attach(list)
    return () => deps.attach(null)
  },
})

export * as TasksPanelMount from "./tasks-panel"
