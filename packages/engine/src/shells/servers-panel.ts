/**
 * لوحُ الخوادم — من المُدار الحيّ، وما لا يُقاس يُقال «غير عامل» ولا يُخفى.
 *
 * القاعدةُ التي تحكم هذا اللوح مأخوذةٌ من المواصفة بنصّها: «خادمٌ لا يُقاس
 * يُقال غير عامل لا يُخفى». والإخفاءُ هو الإغراء الطبيعيّ هنا — قائمةٌ نظيفةٌ
 * أجملُ من قائمةٍ فيها صفٌّ ميّت — لكنّ الإخفاء يجعل المشغّل يظنّ أنّ خادمه
 * لم يبدأ أصلاً بينما هو يعمل على منفذٍ لا نراه، أو أنّه يعمل بينما مات.
 *
 * **الحالةُ ثلاثيّةٌ لا ثنائيّة**، وهذا مقيسٌ من درسٍ في المستودع نفسِه:
 * «لم يُقَس بعد» ليست «لا يعمل». لوحةٌ تخلط بينهما تكذب في أوّل ثانيةٍ من
 * فتحها، حين لم يرجع السبرُ بعد. فالصفّ يعرض ثلاثاً: `measuring` · `up` ·
 * `down` — و`down` تُقال بسببها حين يُعرف.
 *
 * ولا يقيس هذا الملفّ شيئاً بنفسه: القياسُ في المحرّك (سبرُ المنفذ وقراءةُ
 * المستمع)، وهذا يعرض ما قِيس. عرضٌ يقيس بنفسه يصير مصدرَ حقيقةٍ ثانياً
 * يفترق عن الأوّل.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"
import { panelFrame } from "./panel-frame"

export const SERVERS_PANEL_ID = "panel:servers"

/** ما يعرفه المحرّكُ عن خادمٍ واحد — ولا حقلَ يُشتقّ في القشرة. */
export interface ServerRow {
  readonly name: string
  readonly port: number
  /** `measuring` ليست `down`: الأولى «لم نعرف بعد»، والثانية حكمٌ مقيس. */
  readonly state: "measuring" | "up" | "down"
  /** سببُ الحكم حين يكون معروفاً — «المنفذ مغلق»، «لا مستمع». */
  readonly why?: string
}

export interface ServersDeps {
  readonly document: SlotDocument
  readonly anchor: string
  readonly attach: (list: SlotElement | null) => void
  /** يطلب من المحرّك إعادةَ قياس — لا يقيس هنا. */
  readonly refresh: () => void
  /** يفتح خادماً في متصفّح القشرة المدمج بالمسار القائم. */
  readonly open: (row: ServerRow) => void
  readonly onExpand: (next: boolean) => void
  readonly onClose: () => void
  /** اختياريّ: غيابُه غيابُ الزرّ — لا زرٌّ صامت. */
  readonly onPopout?: () => void
  /** رأسُ اللوح مقبضُ نقله. غيابُهما = رأسٌ غيرُ قابلٍ للسحب، لا مقبضٌ ميت. */
  readonly onDragStart?: (event: unknown) => void
  readonly onDragEnd?: () => void
  readonly expanded: boolean
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

const STATE_AR: Readonly<Record<ServerRow["state"], string>> = Object.freeze({
  measuring: "يُقاس…",
  up: "يعمل",
  down: "غير عامل",
})

/**
 * ما رسمناه في كلّ قائمة — كي يُنزع بالضبط ما وُضع.
 *
 * البديلُ المغري كان `list.children` والدوران عليها. لكنّ `SlotElement` **لا
 * تُعلن `children`**، فقراءتُها تسلّلٌ خارج العقد: على تطبيقٍ لا يحملها تصير
 * `undefined`، فلا تدور الحلقة، ولا يُنزع شيء، **وتتراكم الصفوف بصمت** — كلُّ
 * إعادةِ قياسٍ تضيف نسخةً والقائمةُ تكبر بلا خطأ. نتذكّر ما وضعناه بدل أن نسأل
 * الشجرةَ عمّا فيها، فنبقى داخل العقد المُعلَن.
 */
const rendered = new WeakMap<SlotElement, SlotElement[]>()

/**
 * يرسم الصفوف داخل القائمة. مُصدَّرةٌ ليقيسها الاختبار بلا متصفّح، ولتنادَى
 * من القشرة عند كلّ قياسٍ جديد — الرسمُ من البيانات كلَّ مرّة، لا تعديلٌ
 * تراكميٌّ على عقدٍ قائمة يترك صفَّ خادمٍ مات معلّقاً في الشجرة.
 */
export const renderServers = (
  document: SlotDocument,
  list: SlotElement,
  rows: readonly ServerRow[],
  open: (row: ServerRow) => void,
  bind: (target: SlotElement, type: string, handler: (event: never) => void) => void,
): void => {
  for (const previous of rendered.get(list) ?? []) list.removeChild(previous)
  const mine: SlotElement[] = []
  rendered.set(list, mine)
  if (rows.length === 0) {
    const blank = make(document, "span", "act-empty")
    blank.textContent = "لا خادمَ مُدارٌ في هذه الجلسة"
    list.appendChild(blank)
    mine.push(blank)
    return
  }
  for (const row of rows) {
    const item = make(document, "div", `srv-row srv-${row.state}`)
    const name = make(document, "span", "srv-name")
    name.textContent = row.name
    const port = make(document, "span", "srv-port")
    port.textContent = ":" + String(row.port)
    const state = make(document, "span", "srv-state")
    // السببُ يُلحق بالحكم حين يُعرف — حكمٌ بلا سببٍ يُجادَل ولا يُصلَح.
    state.textContent = STATE_AR[row.state] + (row.why === undefined ? "" : ` — ${row.why}`)
    item.appendChild(name)
    item.appendChild(port)
    item.appendChild(state)
    // الفتحُ لِما يعمل وحده: زرٌّ يفتح صفحةَ خطأٍ ليس فعلاً بل إحباط.
    if (row.state === "up") {
      const go = make(document, "button", "iconbtn")
      go.textContent = "↗"
      go.setAttribute("type", "button")
      go.setAttribute("title", `افتح ${row.name} في متصفّح عبدو`)
      go.setAttribute("aria-label", `افتح ${row.name} في متصفّح عبدو`)
      bind(go, "click", () => open(row))
      item.appendChild(go)
    }
    list.appendChild(item)
    mine.push(item)
  }
}

export const serversPanel = (deps: ServersDeps): SlotContribution => ({
  id: SERVERS_PANEL_ID,
  anchor: deps.anchor,
  feature: "serversPanel",
  order: 20,
  mount: (host, bind) => {
    const frame = panelFrame({
      document: deps.document,
      title: "الخوادم",
      action: { label: "⟳", title: "أعِد القياس", onClick: deps.refresh },
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      ...(deps.onPopout === undefined ? {} : { onPopout: deps.onPopout }),
      ...(deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart }),
      ...(deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd }),
      expanded: deps.expanded,
    }, host, bind)

    const list = make(deps.document, "div", "panel-list")
    list.id = "serverrows"
    renderServers(deps.document, list, [], deps.open, bind)
    frame.body.appendChild(list)

    deps.attach(list)
    // الفتحُ يطلب قياساً فوراً: لوحةٌ تنتظر الدورةَ التالية تُري المشغّل
    // حالةً عمرُها دقيقة وتسمّيها حاضرة.
    deps.refresh()
    return () => deps.attach(null)
  },
})

export * as ServersPanelMount from "./servers-panel"
