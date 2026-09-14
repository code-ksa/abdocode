/**
 * S13.5 — الحلقةُ المتداخلة: وكيلُ دورٍ يعمل تحت الدور، لا بجانبه.
 *
 * العقد، وكلُّ بندٍ منه سببُه عطلٌ مدفوع الثمن:
 *
 * **يملك الطفل**: عدّادَ حِقبٍ خاصّاً به، وإيصالاتِه، ودفترَ وعيه (فلا يرث
 * قراءاتِ الأب ولا يلوّثها)، وأثرَه الخاصّ. هذه أشياءٌ لو شاركها لصار الأب
 * والطفل حلقةً واحدةً بمزاجين.
 *
 * **يشارك الأب**: عدّادَ إنفاق الدور، ودفترَ السحابة، وبوّابةَ الموافقة،
 * والنمط، والقضبان. هذه أشياءٌ لو ملكها لصار التفويضُ باباً خلفياً: طفلٌ
 * بعدّادٍ خاصّ يُنفق ضِعفَ سقف الدور، وطفلٌ ببوّابةٍ خاصّة **يوافق على نفسه**.
 *
 * ولذلك: **لا سياسةَ جديدة في هذا الملفّ**. لا بوّابة، ولا نمط، ولا تسعيرة،
 * ولا استثناء. كلُّ أداةٍ يستدعيها الطفل تمرّ من مُوزِّع الأب نفسه (`dispatch`
 * وسيطاً)، فتقف على البوّابة نفسها بالنمط نفسه. والإنفاق يُسأل عنه عدّادُ
 * الأب نفسه (`meter` وسيطاً) بالسؤال نفسه الذي يسأله المضيف قبل كلّ حقبة.
 *
 * والعمقُ مسقوف: الطفلُ لا يفوّض. تفويضٌ متداخلٌ بلا حدّ شجرةٌ تنفق سقفَ
 * الدور في فرعٍ لا يراه أحد.
 *
 * الوحدة خالصةٌ من الأثر: لا قرص ولا شبكة ولا ساعة — المنافذ تُحقن.
 */

import type { DispatchResult, NativeAgentCall, NativeAgentReply, TextAgentLoopOptions, TextAgentLoopResult, TextAgentMessage } from "@abdo/engine-host"
import { agentToolRefusal, type AgentDefinition } from "./agent-definitions"
import { TurnAwareness } from "./turn-awareness"

/** اسمُ أداة التفويض في السجلّ الواحد — مصدرٌ واحد للحارس والكتالوج. */
export const DELEGATE_TOOL = "delegate"

/** أداةُ الفريق المتوازي (هـ2) — يرفضها الطفلُ كما يرفض التفويض: العمقُ واحدٌ لكليهما. */
export const TEAM_TOOL = "team"

/** لوحُ الخطّة — أداةُ الدور الأب وحده. */
export const PLAN_TOOL = "plan"

/** عمقُ التداخل الأقصى: الأب يفوّض، والطفل لا. */
export const MAX_DELEGATION_DEPTH = 1

/** سقوفُ الطفل — أضيق من سقوف الدور بالبناء. */
export const CHILD_MAX_EPOCHS = 3
export const CHILD_MAX_ROUNDS = 6
export const REPORT_MAX_CHARS = 1200
export const REPORT_MAX_COMMANDS = 12
export const REPORT_MAX_REFUSALS = 6

export const DELEGATE_USAGE = "الصيغة: delegate <وكيل> :: <المهمّة>"

export interface DelegateCommand {
  readonly agent: string
  readonly task: string
}

/** خطّةٌ أو نصُّ رفضٍ عربيّ (السلسلة = رفض). */
export const parseDelegateCommand = (rest: string): DelegateCommand | string => {
  const body = rest.trim()
  if (body.length === 0) return DELEGATE_USAGE
  const cut = body.indexOf("::")
  if (cut < 0) return DELEGATE_USAGE
  const agent = body.slice(0, cut).trim()
  const task = body.slice(cut + 2).trim()
  if (agent.length === 0) return DELEGATE_USAGE
  if (task.length === 0) return "delegate يحتاج مهمّةً بعد «::» — وكيلٌ بلا مهمّةٍ لا يُشغَّل"
  return Object.freeze({ agent, task })
}

/**
 * حارسُ الأداة للطفل: سقفُ الوكيل أوّلاً، ثمّ سقفُ العمق. يُستدعى من
 * `isCallable` **و** من غلاف التوزيع — فالرفض يقع قبل أيّ توزيع، لا بعده.
 */
export const childToolRefusal = (agent: AgentDefinition, word: string, depth: number): string | undefined => {
  const trimmed = word.trim()
  if (trimmed === DELEGATE_TOOL || trimmed === TEAM_TOOL) {
    return `رُفضت «${trimmed}»: الوكيل المفوَّض لا يفوّض (عمق ${depth} وسقفُ العمق ${MAX_DELEGATION_DEPTH}).`
  }
  // لوحُ الخطّة ملكُ الدور الذي فوّض: طفلٌ يعيد كتابته يمحو خطّةً يقودها غيرُه ويظهر في لوح المشغّل كأنّ الأبَ غيّر رأيه.
  if (trimmed === PLAN_TOOL) return `رُفضت «${PLAN_TOOL}»: لوحُ الخطّة ملكُ الدور الذي فوّضك — اكتب ما أنجزتَه في تقريرك.`
  return agentToolRefusal(agent, trimmed)
}

/**
 * ما تحتاجه الحلقة من عدّاد الأب — سؤالٌ واحد، بلا صلاحيةِ شحنٍ ولا سماحة،
 * و**بلا وسيطِ حقبة**. العطلُ المقيس (2026-09-03): `gate(epoch)` تكتب
 * `TurnSpendMeter.epoch`، فحقبةُ الطفل (١..٣) كانت تدهس علامةَ حقبة الأب
 * فتُبطل سماحةً كان المضيف قد منحها وأعلنها للمشغّل — والسماحة تبقى محروقة
 * (`graceUsed`) فلا تُمنح ثانيةً. الاتجاه مغلقٌ لا مفتوح، لكنه بترٌ صامتٌ
 * لدورٍ مُدّد عمداً. حذفُ الوسيط يجعل الكتابةَ مستحيلةً بالبناء لا بالوعد.
 */
export interface DelegateMeter {
  gate(): "open" | "exhausted"
}

export type DelegateStop = "complete" | "epoch-limit" | "budget" | "interrupted" | "tool-failed" | "duplicate"

export interface DelegateReport {
  readonly agent: string
  /** مشتقّةٌ من أدوات الوكيل المعلَنة — تُنقل كما هي ولا تُعاد استنتاجاً. */
  readonly readOnly: boolean
  readonly epochs: number
  readonly commands: readonly string[]
  readonly refusals: readonly string[]
  readonly stop: DelegateStop
  /** الجوابُ الخاتم للطفل، مسقوفاً. */
  readonly answer: string
}

export type RunLoopPort = (options: TextAgentLoopOptions) => Promise<TextAgentLoopResult>

export interface DelegateOptions {
  readonly agent: AgentDefinition
  readonly task: string
  /** عمقُ الأب: 0 للدور نفسه. */
  readonly depth: number
  /** نداءُ النموذج — **نفسُه** الذي يستعمله الأب، فيُحاسَب في دفتره وعدّاده. */
  readonly ask: (prompt: string, history: readonly TextAgentMessage[], allowlist: readonly string[]) => Promise<string | NativeAgentReply>
  /** مُوزِّعُ الأب نفسه — البوّابة والنمط والقضبان تأتي منه، لا من هنا. */
  readonly dispatch: (command: string, nativeCall?: NativeAgentCall) => Promise<string | DispatchResult>
  readonly runLoop: RunLoopPort
  /** عدّادُ إنفاق الدور — الأبُ يملكه، والطفل يسأله ولا يوسّعه. */
  readonly meter?: DelegateMeter
  readonly signal?: AbortSignal
  readonly maxEpochs?: number
  readonly maxRounds?: number
  readonly onEpoch?: (epoch: number) => void
}

const CONTINUE_LINE = "واصل المهمّة المفوَّضة من نقطة التوقف، ولا تبدأ من جديد."

/** مدخلُ الحقبة الأولى: رسالةُ نظام الوكيل ثمّ مهمّتُه ثمّ سقفُه صراحةً. */
export const childBrief = (agent: AgentDefinition, task: string): string =>
  `${agent.instructions}\n\n` +
  `المهمّة المفوَّضة إليك:\n${task}\n\n` +
  `أدواتك المتاحة (وهي كلُّ ما تستطيع): ${agent.tools.join("، ")}.` +
  (agent.readOnly ? " سقفُك قراءةٌ فقط — لا كتابةَ ولا تنفيذ.\n" : "\n") +
  "لا تفوّض إلى وكيلٍ آخر. أنهِ بجوابٍ واحدٍ موجز يصلح تقريراً لمن فوّضك.\n"

/**
 * يشغّل الوكيل المفوَّض. الطفلُ حِقبٌ صغيرة على الحلقة النصّيّة نفسها —
 * لا حلقةَ ثانية، ولا مُوزِّعَ ثانٍ، ولا بوّابةَ ثانية.
 */
export const runDelegatedAgent = async (options: DelegateOptions): Promise<DelegateReport> => {
  const { agent, depth } = options
  const maxEpochs = Math.max(1, options.maxEpochs ?? CHILD_MAX_EPOCHS)
  const maxRounds = Math.max(1, options.maxRounds ?? CHILD_MAX_ROUNDS)

  // دفترُ وعيٍ خاصٌّ بالطفل: لا يقرأ وعيَ الأب ولا يكتب فيه.
  const awareness = new TurnAwareness()
  const commands: string[] = []
  const refusals: string[] = []
  let history: TextAgentMessage[] = []
  let answer = ""
  let epochs = 0
  let stop: DelegateStop = "epoch-limit"
  let pending: string | undefined

  for (let epoch = 1; epoch <= maxEpochs; epoch += 1) {
    if (options.signal?.aborted === true) { stop = "interrupted"; break }
    // السؤالُ نفسه الذي يسأله المضيفُ قبل كلّ حقبةٍ من حِقب الأب — بلا سماحة
    // و**بلا حقبة**: السماحةُ واحدةٌ لكلّ دور وهي قرارُ الأب، لا يُنفقها فرعٌ
    // متداخل ولا يزحزح علامتَها. سؤالٌ لا يحرّك حالةَ الأب بحرفٍ واحد.
    if (options.meter?.gate() === "exhausted") { stop = "budget"; break }
    epochs = epoch
    options.onEpoch?.(epoch)
    const brief = awareness.brief()
    const input = epoch === 1
      ? childBrief(agent, options.task)
      : `${CONTINUE_LINE}\n${options.task}\n${brief}` +
        (pending === undefined ? "" : `الأداة التالية التي اقترحتَها ولم تُنفَّذ بعد:\n${pending}\n`)

    const loop = await options.runLoop({
      input,
      history,
      ask: (prompt, prior) => options.ask(prompt, prior, agent.tools),
      dispatch: async (command, nativeCall) => {
        const word = command.split(/\s+/u)[0] ?? ""
        const refusal = childToolRefusal(agent, word, depth)
        if (refusal !== undefined) {
          // رفضٌ **قبل** التوزيع: لا نداءَ يخرج، ولا أثرَ يُكتب.
          refusals.push(refusal)
          return { output: refusal, verdict: { ok: false, reason: "tool_not_permitted", denied: true, detail: refusal.slice(0, 160) } }
        }
        return options.dispatch(command, nativeCall)
      },
      isCallable: (toolName) => childToolRefusal(agent, toolName, depth) === undefined,
      priorCommands: commands,
      onToolResult: (command, output) => {
        commands.push(command)
        awareness.observe(command, output, epoch)
      },
      maxRounds,
    })

    answer = loop.answer
    history = [...loop.continuation]
    pending = loop.pendingCommand
    if (loop.stopReason === "complete") { stop = "complete"; break }
    // تكرارُ الاستدعاء نفسه توقّفٌ باسمه لا «تمام»: طيُّه إلى «أنهى» يقلب
    // فشلَ دورانٍ إلى نجاحٍ في التقرير الذي يبني عليه الأب.
    if (loop.stopReason === "duplicate") { stop = "duplicate"; break }
    if (loop.stopReason === "tool-failed") stop = "tool-failed"
  }

  return Object.freeze({
    agent: agent.name,
    readOnly: agent.readOnly,
    epochs,
    commands: Object.freeze([...commands]),
    refusals: Object.freeze([...refusals]),
    stop,
    answer: answer.slice(0, REPORT_MAX_CHARS),
  })
}

const STOP_TEXT: Readonly<Record<DelegateStop, string>> = Object.freeze({
  complete: "أنهى",
  "epoch-limit": "بلغ سقف حِقبه",
  budget: "أوقفه سقف إنفاق الدور",
  interrupted: "قوطع بيد المشغّل",
  "tool-failed": "فشلت آخر أداة",
  duplicate: "كرّر الاستدعاء نفسه فوُقف",
})

/** تقريرٌ مسقوفٌ بنيوياً يقرؤه الأب — لا نصٌّ حرٌّ يتضخّم بطول عمل الطفل. */
export const renderDelegateReport = (report: DelegateReport): string => {
  const lines: string[] = []
  lines.push(`🤝 تقرير الوكيل «${report.agent}» — ${report.readOnly ? "قراءة-فقط (مشتقٌّ من أدواته المعلَنة)" : "يكتب/ينفّذ"}`)
  lines.push(`الحِقب: ${report.epochs} · الأدوات المنفَّذة: ${report.commands.length} · المرفوضة: ${report.refusals.length} · التوقّف: ${STOP_TEXT[report.stop]}`)
  if (report.commands.length > 0) {
    lines.push(`نُفّذ: ${report.commands.slice(0, REPORT_MAX_COMMANDS).map((c) => c.split("\n", 1)[0]!.slice(0, 90)).join(" | ")}`)
  }
  for (const refusal of report.refusals.slice(0, REPORT_MAX_REFUSALS)) lines.push(`⛔ ${refusal.slice(0, 200)}`)
  lines.push(`الخلاصة: ${report.answer.length > 0 ? report.answer : "(بلا جواب)"}`)
  return lines.join("\n")
}
