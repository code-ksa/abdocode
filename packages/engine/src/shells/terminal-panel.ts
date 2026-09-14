/**
 * Agent command receipts retain the guarded submit/attach contract below.
 * Native desktop can supply a separate, user-operated interactive PTY mount.
 * The historical receipt-only shell remains the fallback for other clients.
 *
 * لوحُ الطرفيّة — إيصالات الأوامر في المسار غير التفاعلي.
 *
 * المواصفة طلبت «لوحَ طرفيّةٍ بألسنة». والمقيس أنّ ما نملكه اليوم إيصالاتٌ لا
 * بثّ: `launchControlledProcess` يستنزف أنبوبَي الابن بـ`Response(...).text()`
 * ثمّ ينتظر الخروج، فالخرجُ يصل **كتلةً واحدةً بعد انتهاء العملية**. وما تراه
 * القشرةُ «بثّاً» اليوم إعادةُ عرضٍ سطراً سطراً لنصٍّ اكتمل. فبناءُ لوحٍ يوهم
 * بالحياة كذبةٌ في الواجهة: دوّارةٌ تدور ولا سبيل إلى تمييز بناءٍ بطيءٍ من
 * أمرٍ معلّق. يُقال بحدّه: **سجلُّ أوامرَ وإيصالاتُها**، والبثُّ حين يصير في
 * المحرّك بثّاً.
 *
 * **ولا فولدَ ثانياً**: الصفوف تأتي من فولد «المسار» القائم (`trajectory.ts`)
 * الذي يزوّج `tool` بـ`tool-result` أصلاً ويحمل الأمرَ وحكمَه وزمنَه ورأسَ
 * خرجه. فولدٌ ثانٍ للأُطر نفسها هو أغلى صنفِ عيبٍ في هذا المستودع بشهادة
 * جرده — وأوّلُ اختلافٍ بين الفولدين يجعل اللوحَ يناقض المحادثة.
 *
 * **ولا بابَ حول الموافقات**: حقلُ الأمر يسلّم نصَّه إلى `submit` التي تمرّ
 * بالمسار المثبَّت نفسِه الذي يسلكه لسان «عمل» — أي `run <الأمر>` عبر مُوزِّع
 * الأدوات فبوّابةِ النمط. الطرفية الأصلية منفذ المستخدم المباشر، وليست أداة للوكيل.
 */

import type { SlotContribution, SlotDocument, SlotElement } from "./slot-host"
import { panelFrame, type PanelAction } from "./panel-frame"

export const TERMINAL_PANEL_ID = "panel:terminal"

export interface TerminalDeps {
  readonly document: SlotDocument
  /** المِرساة المُعلَنة التي يُركَّب فيها اللوح. */
  readonly anchor: string
  /** يسلّم القشرةَ عقدةَ القائمة عند التركيب و`null` عند الفكّ. */
  readonly attach: (list: SlotElement | null) => void
  /** المسارُ المثبَّت: `run <الأمر>` عبر البوّابة — لا تنفيذٌ من هنا. */
  readonly submit: (command: string) => void
  readonly onExpand: (next: boolean) => void
  readonly onClose: () => void
  /** اختياريّ: غيابُه غيابُ الزرّ — لا زرٌّ صامت. */
  readonly onPopout?: () => void
  /** رأسُ اللوح مقبضُ نقله. غيابُهما = رأسٌ غيرُ قابلٍ للسحب، لا مقبضٌ ميت. */
  readonly onDragStart?: (event: unknown) => void
  readonly onDragEnd?: () => void
  readonly expanded: boolean
  /** Native-only user PTY mount. Agent command receipts keep attach/submit. */
  readonly mountInteractive?: (host: SlotElement, attach: TerminalDeps["attach"]) => () => void
}

const make = (document: SlotDocument, tag: string, className?: string): SlotElement => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

export const terminalPanel = (deps: TerminalDeps): SlotContribution => ({
  id: TERMINAL_PANEL_ID,
  anchor: deps.anchor,
  feature: "terminalPanel",
  order: 10,
  mount: (host, bind) => {
    const input = make(deps.document, "input", "panel-input")
    input.setAttribute("placeholder", "أمرٌ يمرّ ببوّابة الموافقة…")
    input.setAttribute("aria-label", "أمرٌ جديد")
    input.setAttribute("spellcheck", "false")

    const send: PanelAction = {
      label: "▶",
      title: "نفّذ الأمر (يمرّ ببوّابة النمط)",
      onClick: () => {
        const text = (input.value ?? "").trim()
        if (text.length === 0) return
        input.value = ""
        deps.submit(text)
      },
    }

    const frame = panelFrame({
      document: deps.document,
      title: deps.mountInteractive ? "Terminal" : "الطرفيّة",
      ...(deps.mountInteractive ? {} : { action: send }),
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      ...(deps.onPopout === undefined ? {} : { onPopout: deps.onPopout }),
      ...(deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart }),
      ...(deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd }),
      expanded: deps.expanded,
    }, host, bind)

    if (deps.mountInteractive) return deps.mountInteractive(frame.body, deps.attach)

    const list = make(deps.document, "div", "panel-list")
    list.id = "terminalrows"
    const blank = make(deps.document, "span", "act-empty")
    // الغيابُ يُقال باسمه: «لم يُنفَّذ أمرٌ بعد» لا فراغٌ يُقرأ عطلاً.
    blank.textContent = "لم يُنفَّذ أمرٌ في هذه الجلسة بعد"
    list.appendChild(blank)

    const row = make(deps.document, "div", "panel-inputrow")
    row.appendChild(input)
    frame.body.appendChild(list)
    frame.body.appendChild(row)

    bind(input, "keydown", (event) => {
      const key = (event as unknown as { key?: string }).key
      if (key === "Enter") send.onClick()
    })

    deps.attach(list)
    // الفكُّ يقطع الوصلَ أوّلاً: قشرةٌ ترسم في عقدةٍ نُزعت من الشجرة تكتب في
    // العدم بلا خطأ، فيبدو اللوحُ «مفتوحاً ولا يتحدّث».
    return () => deps.attach(null)
  },
})

export * as TerminalPanelMount from "./terminal-panel"
