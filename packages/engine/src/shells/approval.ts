/**
 * IDEA 7 — استيلاء الموافقة على مقعد المؤلِّف، مُختزَلاً إلى مُخفِّضٍ خالص.
 *
 * الموافقة اليوم كتلةٌ في المحادثة تُمحى بالنقر: الزرّ يزول ويُكتب «سُمح»
 * فوراً — أي أن **النقرة** هي الحقيقة. لكن الحقيقة هي ما يُثبته المحرّك في
 * الدفتر؛ فإن سقط النداء بين النقرة والقرار بقيت اللوحة تقول ما لم يقع.
 * هنا القاعدة مقلوبة: النقرة تنقل الحالة إلى **«يُقرَّر»** (الأزرار مقفلة،
 * لا محو)، ولا تعود إلى السكون إلا على سطر القرار الوارد من الدفتر —
 * `🔐 قرار الموافقة: …` — أو على انتهاء الدور نفسه.
 *
 * ثلاث قواعد مبنيّة لا موصوفة:
 * - **مقعدٌ واحد**: موافقةٌ ثانيةٌ لدورٍ **آخر** ⇒ رفضٌ **مسمّى**، والحالة لا
 *   تُمسّ (المحرّك يفهرس بالدور فلا يقع هذا إلا بخللٍ — ويُسمّى ولا يُبتلع).
 *   أمّا سؤالٌ ثانٍ للدور نفسه فيستولي على المقعد: دليلُ تجاوزٍ لا خلل.
 * - **Escape رفضٌ لا هروب**: في حالة السؤال، الهروب قرارُ منع لا تجاهل.
 * - **الاتّجاه المُغلق**: كلُّ ما ليس قراراً صريحاً يغلق المقعد بـ«أُغلق»،
 *   ولا يُخمَّن منه سماحٌ أبداً.
 *
 * خالصة: لا DOM ولا شبكة ولا زمن. القشرة ترسم من الحالة، والمحرّك لا يعرفها.
 */

import { APPROVAL_DECIDED_PREFIX, decisionOfLine, type ApprovalDecision } from "../approval-ledger"

export type ApprovalState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "asked"
      readonly turnId: string
      readonly request: string
      readonly cls: string
      readonly mode: string
      /** رأى المشغّل معاينة الفرق لهذا الدور قبل السؤال؟ (زرّ «المعاينة»). */
      readonly diffSeen: boolean
    }
  | {
      readonly kind: "deciding"
      readonly turnId: string
      readonly request: string
      readonly cls: string
      readonly mode: string
      readonly diffSeen: boolean
      readonly choice: "approve" | "deny"
    }

/** كيف أُغلق المقعد — القرار المسمّى، أو إغلاقٌ بانتهاء الدور. */
export type ApprovalSettled = ApprovalDecision | "closed"

export interface ApprovalStore {
  readonly state: ApprovalState
  /** أدوارٌ وصلت لها معاينة فرقٍ (سقفٌ صغير — ذاكرةُ عرضٍ لا سجلّ). */
  readonly diffs: readonly string[]
}

export interface ApprovalFold {
  readonly store: ApprovalStore
  /** رفضٌ مسمّى — لا صمت، ولا حالةٌ تُمسّ. */
  readonly refused?: string
  readonly settled?: ApprovalSettled
}

const DIFF_CAP = 8
const IDLE: ApprovalState = Object.freeze({ kind: "idle" as const })

export const empty = (): ApprovalStore => Object.freeze({ state: IDLE, diffs: Object.freeze([] as readonly string[]) })

const same = (store: ApprovalStore): ApprovalFold => ({ store })
const settle = (store: ApprovalStore, settled: ApprovalSettled): ApprovalFold => ({
  store: Object.freeze({ state: IDLE, diffs: store.diffs }),
  settled,
})

/** الدور الذي يشغل المقعد الآن، أو `undefined` في السكون. */
export const pendingTurn = (store: ApprovalStore): string | undefined =>
  store.state.kind === "idle" ? undefined : store.state.turnId

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

export const fold = (store: ApprovalStore, frame: Record<string, unknown>): ApprovalFold => {
  const kind = asText(frame.kind)
  const turnId = asText(frame.turnId)
  if (kind === "diff") {
    if (turnId.length === 0) return same(store)
    const diffs = store.diffs.includes(turnId) ? store.diffs : [...store.diffs, turnId].slice(-DIFF_CAP)
    const state = store.state.kind === "asked" && store.state.turnId === turnId
      ? { ...store.state, diffSeen: true }
      : store.state
    return same(Object.freeze({ state, diffs: Object.freeze(diffs) }))
  }
  // «مقعدٌ واحد» يعني دوراً واحداً، لا طلباً واحداً إلى الأبد: سؤالٌ ثانٍ
  // **للدور نفسه** دليلٌ قاطع أن المحرّك تجاوز الأوّل (سطرُ قرارٍ سقطت
  // كتابته، أو مفتاحٌ أُطفئ عند المحرّك والقشرةُ ما تزال مستولية)، فيستولي
  // الجديد على المقعد. الرفضُ هناك كان يترك المشغّل أمام طلبٍ ميّتٍ بأزرارٍ
  // مقفلة: لا جوابَ للثاني، والمؤلِّف مقفلٌ حتى المقاطعة. والرفضُ المسمّى
  // يبقى لما هو خللٌ حقّاً — مقعدٌ يشغله دورٌ **آخر**.
  if (kind === "approval") {
    if (store.state.kind !== "idle" && turnId.length > 0 && store.state.turnId !== turnId) return { store, refused: "موافقة معلّقة أخرى — المقعد واحد" }
    if (turnId.length === 0) return { store, refused: "طلب موافقة بلا دور — لا يُعرض" }
    return same(Object.freeze({
      state: Object.freeze({
        kind: "asked" as const,
        turnId,
        request: asText(frame.request),
        cls: asText(frame.class),
        mode: asText(frame.mode),
        diffSeen: store.diffs.includes(turnId),
      }),
      diffs: store.diffs,
    }))
  }
  if (store.state.kind === "idle") return same(store)
  if (turnId !== store.state.turnId) return same(store)
  if (kind === "event") {
    const decision = decisionOfLine(frame.payload)
    // سطرُ قرارٍ بصيغةٍ لا نعرفها: لا يُخمَّن سماحاً — يُغلق المقعد بـ«أُغلق».
    if (decision !== undefined) return settle(store, decision)
    if (asText(frame.payload).startsWith(APPROVAL_DECIDED_PREFIX)) return settle(store, "closed")
    return same(store)
  }
  if (kind === "done" || kind === "interrupted" || kind === "unresolved") return settle(store, "closed")
  return same(store)
}

/** نقرةُ المشغّل — تنقل إلى «يُقرَّر» ولا تمحو شيئاً؛ الدفتر هو الحَكَم. */
export const choose = (store: ApprovalStore, choice: "approve" | "deny"): ApprovalFold => {
  if (store.state.kind !== "asked") return { store, refused: "لا موافقة معلّقة تُقرَّر" }
  return same(Object.freeze({
    state: Object.freeze({ ...store.state, kind: "deciding" as const, choice }),
    diffs: store.diffs,
  }))
}

/** Escape في حالة السؤال = رفضٌ صريح؛ وفي غيرها لا شيء (لا مقاطعةَ عرضاً). */
export const escape = (store: ApprovalStore): ApprovalFold =>
  store.state.kind === "asked" ? choose(store, "deny") : same(store)

export * as Approval from "./approval"
