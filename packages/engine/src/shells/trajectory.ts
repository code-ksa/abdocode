/**
 * IDEA 8 — لسان «المسار»: عدسةٌ تشخيصيّة مطويّة من الأُطر التي على السلك أصلاً.
 *
 * المحادثة تعرض الأداة كتلةً ونتيجتَها كتلةً أخرى مطويّة، وأسطرَ الأحداث
 * (📐 💳 ✓ نقطة حفظ 🎯 🚪 …) نصّاً متتابعاً داخل كتلة الجواب. فما لا يُرى:
 * **أيّ نتيجةٍ تخصّ أيّ أداة**، وكم استغرقت، وبأيّ حكم. هذا الفولد يزوّج
 * `tool` بـ`tool-result` بالدور والأمر — المفتاح نفسه الذي تستعمله المحادثة —
 * فيصير الزوج صفّاً واحداً بحكمه وسببه وزمنه.
 *
 * قواعد حاكمة:
 * - **لا إعادة حساب**: سطرُ الحدث يُخزَّن **بنصّه** ويُصنَّف ببادئته وحدها.
 *   التغطية والسحابة ونقطة الحفظ أرقامٌ يملكها المحرّك — تُعرض ولا تُشتقّ.
 * - **الصمت يُسمّى**: دورٌ أُعيد من السجلّ يصل بأُطر `event` وحدها (لا
 *   `tool` ولا `tool-result`)، فيُوسَم `eventsOnly` ليقول اللسان «أحداث
 *   فقط» بدل أن يوهم بأن صفر أداةٍ عملت.
 * - **سقفٌ معلَن**: الأدوار تُطرد بترتيب وصولها بعد السقف — مخزنُ عرضٍ لا سجلّ.
 *
 * خالصة: لا DOM ولا زمنَ داخليّ (`nowMs` يُمرَّر)، ولا تلمس المحرّك بشيء.
 */

export type GateKind =
  | "coverage" | "cloud" | "checkpoint" | "miner" | "intent" | "turn-budget"
  | "gate" | "wall" | "approval-asked" | "approval-decided" | "epoch"
  | "warning" | "meta" | "other"

export interface ToolRow {
  readonly cmd: string
  readonly epoch: number
  readonly acceptance: boolean
  readonly intent?: string
  /** لحظةُ إطار `tool` — **غائبةٌ** إن لم يُرَ الإطار (نتيجةٌ يتيمة). */
  readonly startedAt?: number
  readonly endedAt?: number
  readonly verdict?: { readonly ok: boolean; readonly reason?: string; readonly denied?: boolean }
  readonly idempotencyKey?: string
  readonly outputHead?: string
}

export interface GateRow {
  readonly kind: GateKind
  /** نصُّ السطر كما وصل — حرفاً بحرف. */
  readonly text: string
  readonly epoch: number
}

export interface TurnTrace {
  readonly turnId: string
  readonly body?: string
  readonly rails?: { readonly tier: string; readonly reason: string }
  readonly route?: { readonly lane: string; readonly ref: string }
  readonly tools: readonly ToolRow[]
  readonly gates: readonly GateRow[]
  readonly outcome?: "completed" | "checkpointed" | "interrupted" | "unresolved" | "failed"
  readonly toolFrames: number
  readonly eventFrames: number
  readonly lastEpoch: number
}

export interface TrajectoryStore {
  readonly turns: ReadonlyMap<string, TurnTrace>
  readonly order: readonly string[]
  readonly cap: number
}

export const DEFAULT_CAP = 24

export const empty = (cap: number = DEFAULT_CAP): TrajectoryStore =>
  Object.freeze({ turns: new Map<string, TurnTrace>(), order: Object.freeze([] as readonly string[]), cap: cap > 0 ? cap : DEFAULT_CAP })

const blank = (turnId: string): TurnTrace => ({
  turnId, tools: [], gates: [], toolFrames: 0, eventFrames: 0, lastEpoch: 0,
})

/** البادئة تحكم — ترتيب الفحص من الأخصّ إلى الأعمّ، ولا اشتقاق من المتن. */
const GATE_PREFIXES: readonly (readonly [string, GateKind])[] = Object.freeze([
  ["📐 أحكام الأدوات", "coverage"],
  ["💳", "cloud"],
  ["✓ نقطة حفظ الحقبة", "checkpoint"],
  ["📓", "miner"],
  ["🎯", "intent"],
  ["⏱", "turn-budget"],
  ["🕰", "turn-budget"],
  ["🚪", "gate"],
  ["⛔", "wall"],
  ["🔐 قرار الموافقة: ", "approval-decided"],
  ["🔐 طلب موافقة", "approval-asked"],
  ["↻", "epoch"],
  ["⚠", "warning"],
  ["— المقيس", "meta"],
] as const)

export const classifyEvent = (payload: string): GateKind => {
  for (const [prefix, kind] of GATE_PREFIXES) if (payload.startsWith(prefix)) return kind
  return "other"
}

const EPOCH_PATTERNS: readonly RegExp[] = Object.freeze([
  /^↻ حقبة (\d+)/u,
  /^✓ نقطة حفظ الحقبة (\d+)/u,
  /^📐 أحكام الأدوات ح(\d+)/u,
  /^🎯 نيّات الحقبة (\d+)/u,
  /الحقبة (\d+)/u,
])

/** حقبةُ السطر إن سمّاها بنفسه — وإلا `undefined` (فتُنسب إلى آخر حقبة رُئيت). */
export const epochOfEvent = (payload: string): number | undefined => {
  for (const pattern of EPOCH_PATTERNS) {
    const found = pattern.exec(payload)
    if (found !== null) {
      const value = Number(found[1])
      if (Number.isSafeInteger(value) && value >= 0) return value
    }
  }
  return undefined
}

const withTurn = (store: TrajectoryStore, turnId: string, next: TurnTrace): TrajectoryStore => {
  const turns = new Map(store.turns)
  const known = turns.has(turnId)
  turns.set(turnId, next)
  let order = known ? store.order.slice() : [...store.order, turnId]
  while (order.length > store.cap) {
    const oldest = order[0]!
    order = order.slice(1)
    turns.delete(oldest)
  }
  return Object.freeze({ turns, order: Object.freeze(order), cap: store.cap })
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "")
const asEpoch = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0)

/** يسجّل نصّ الدور لحظة إرساله — القشرة وحدها تعرفه (لا إطار وارد يحمله). */
export const begin = (store: TrajectoryStore, turnId: string, body: string): TrajectoryStore => {
  if (typeof turnId !== "string" || turnId.length === 0) return store
  const trace = store.turns.get(turnId) ?? blank(turnId)
  return withTurn(store, turnId, { ...trace, body })
}

export const fold = (store: TrajectoryStore, frame: Record<string, unknown>, nowMs: number): TrajectoryStore => {
  const kind = asText(frame.kind)
  const turnId = asText(frame.turnId)
  if (turnId.length === 0) return store
  const trace = store.turns.get(turnId) ?? blank(turnId)

  if (kind === "rails") {
    return withTurn(store, turnId, { ...trace, rails: { tier: asText(frame.tier), reason: asText(frame.reason) } })
  }
  if (kind === "model-route") {
    return withTurn(store, turnId, { ...trace, route: { lane: asText(frame.lane), ref: asText(frame.ref) } })
  }
  if (kind === "tool") {
    const epoch = asEpoch(frame.epoch)
    const row: ToolRow = {
      cmd: asText(frame.cmd),
      epoch,
      acceptance: frame.acceptance === true,
      ...(typeof frame.intent === "string" ? { intent: frame.intent } : {}),
      startedAt: nowMs,
    }
    return withTurn(store, turnId, {
      ...trace, tools: [...trace.tools, row], toolFrames: trace.toolFrames + 1, lastEpoch: epoch,
    })
  }
  if (kind === "tool-result") {
    const cmd = asText(frame.cmd)
    const epoch = asEpoch(frame.epoch)
    // أقدمُ صفٍّ مفتوحٍ بالأمر نفسه يُغلق أوّلاً — أمرٌ يتكرّر في دورٍ واحد
    // يعطي صفَّين لا صفّاً يُدهَس (المحادثة تدهسه؛ اللسان لا).
    const index = trace.tools.findIndex((row) => row.cmd === cmd && row.endedAt === undefined)
    const verdict = frame.verdict as ToolRow["verdict"] | undefined
    const completion = {
      endedAt: nowMs,
      ...(verdict !== undefined && typeof verdict === "object" ? { verdict } : {}),
      ...(typeof frame.idempotencyKey === "string" ? { idempotencyKey: frame.idempotencyKey } : {}),
      outputHead: asText(frame.output).slice(0, 160),
    }
    const tools = index >= 0
      ? trace.tools.map((row, i) => (i === index ? { ...row, ...completion } : row))
      // نتيجةٌ بلا إطار أداةٍ سابق (إعادةُ وصلٍ وسط دور): صفٌّ بلا بداية
      // مشهودة. ختمُه بـ`nowMs` كان يخترع مدّةً «+0.0s» لأداةٍ لم نرَ
      // انطلاقها — بناءُ بناءٍ استغرق أربعين ثانية يُعرض صفراً. الغياب
      // يُقال («—») كما يُقال في الصفّ الذي لم ينتهِ بعد.
      : [...trace.tools, { cmd, epoch, acceptance: frame.acceptance === true, ...completion }]
    return withTurn(store, turnId, { ...trace, tools, lastEpoch: epoch === 0 ? trace.lastEpoch : epoch })
  }
  if (kind === "event") {
    const text = asText(frame.payload)
    const epoch = epochOfEvent(text) ?? trace.lastEpoch
    const row: GateRow = { kind: classifyEvent(text), text, epoch }
    return withTurn(store, turnId, { ...trace, gates: [...trace.gates, row], eventFrames: trace.eventFrames + 1 })
  }
  if (kind === "done") {
    const outcome = frame.outcome === "checkpointed" ? "checkpointed" : "completed"
    return withTurn(store, turnId, { ...trace, outcome: trace.outcome === "interrupted" ? "interrupted" : outcome })
  }
  if (kind === "interrupted") return withTurn(store, turnId, { ...trace, outcome: "interrupted" })
  if (kind === "unresolved") return withTurn(store, turnId, { ...trace, outcome: "unresolved" })
  if (kind === "refused") return withTurn(store, turnId, { ...trace, outcome: "failed" })
  return store
}

export interface RenderTool {
  readonly cmd: string
  readonly glyph: "✓" | "✕" | "·"
  readonly reason: string
  readonly denied: boolean
  readonly duration: string
  readonly acceptance: boolean
  readonly intent?: string
  readonly outputHead?: string
}

export interface RenderEpoch {
  readonly epoch: number
  readonly tools: readonly RenderTool[]
  readonly gates: readonly GateRow[]
}

export interface RenderTurn {
  readonly turnId: string
  readonly body?: string
  readonly rails?: { readonly tier: string; readonly reason: string }
  readonly route?: { readonly lane: string; readonly ref: string }
  readonly outcome?: TurnTrace["outcome"]
  /** أُعيد من السجلّ: أحداثٌ بلا أدوات — يُقال، ولا يُترك يوهم بصفر أدوات. */
  readonly eventsOnly: boolean
  readonly epochs: readonly RenderEpoch[]
}

/** مدّةٌ تُقاس أو لا تُقال: طرفٌ غائب (بدايةً أو نهاية) ⇒ «—» لا رقمٌ مخترَع. */
const duration = (row: ToolRow): string =>
  row.startedAt === undefined || row.endedAt === undefined
    ? "—"
    : `+${Math.max(0, (row.endedAt - row.startedAt) / 1000).toFixed(1)}s`

export const rows = (store: TrajectoryStore, turnId: string): RenderTurn | undefined => {
  const trace = store.turns.get(turnId)
  if (trace === undefined) return undefined
  const numbers = new Set<number>()
  for (const row of trace.tools) numbers.add(row.epoch)
  for (const row of trace.gates) numbers.add(row.epoch)
  const epochs: RenderEpoch[] = [...numbers].sort((a, b) => a - b).map((epoch) => ({
    epoch,
    tools: trace.tools.filter((row) => row.epoch === epoch).map((row) => ({
      cmd: row.cmd,
      glyph: row.verdict === undefined ? "·" : row.verdict.ok ? "✓" : "✕",
      reason: row.verdict !== undefined && !row.verdict.ok ? (row.verdict.reason ?? "") : "",
      denied: row.verdict !== undefined && row.verdict.ok === false && row.verdict.denied === true,
      duration: duration(row),
      acceptance: row.acceptance,
      ...(row.intent === undefined ? {} : { intent: row.intent }),
      ...(row.outputHead === undefined ? {} : { outputHead: row.outputHead }),
    } as RenderTool)),
    gates: trace.gates.filter((row) => row.epoch === epoch),
  }))
  return {
    turnId: trace.turnId,
    ...(trace.body === undefined ? {} : { body: trace.body }),
    ...(trace.rails === undefined ? {} : { rails: trace.rails }),
    ...(trace.route === undefined ? {} : { route: trace.route }),
    ...(trace.outcome === undefined ? {} : { outcome: trace.outcome }),
    // الرايةُ من **الصفوف المرسومة** لا من عدّ الأُطر: نتيجةٌ يتيمة تبني صفّاً
    // بلا إطار `tool`، فكان `toolFrames === 0` يعلّق لافتة «أحداثٌ فقط — خلوُّ
    // الصفوف ليس دليلاً» فوق صفوفٍ غيرِ خالية. عدسةٌ تناقض نفسها في الموضع
    // الذي وُعدت فيه بألّا توهم.
    eventsOnly: trace.tools.length === 0 && trace.eventFrames > 0,
    epochs,
  }
}

/** أحدثُ أوّلاً — قائمةُ منتقي الأدوار. */
export const turns = (store: TrajectoryStore): readonly string[] => store.order.slice().reverse()

export * as Trajectory from "./trajectory"
