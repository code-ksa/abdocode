/**
 * ذ4 — إغلاقُ الحلقة: إيصالُ بوّابات القبول يفرّق **«فشل»** عن **«لم يُفحص»**.
 *
 * كانت الحالةُ لكلّ بوّابةٍ مطلوبةٍ بِتّاً واحداً (`successfulBuild`): كاذبٌ حين فشل البناء وكاذبٌ
 * حين لم يُنفَّذ أصلاً — والرسالةُ الواحدة «لا يوجد إيصال بناء ناجح» تغطّي الحالتين. الفرقُ ليس
 * بلاغياً: «فشل» يعني أن الشيفرةَ الحاليّة فُحصت وسقطت (أصلحها)، و«لم يُفحص» يعني أن لا أحد
 * يعرف (افحص). والوكيلُ الذي يخلط بينهما يعيد فحصاً لم يفشل أو يدّعي نجاحاً لم يُقس.
 *
 * القاعدةُ ذاتُ الأسنان: **`unverified` لا يُحسب نجاحاً أبداً** — `acceptanceSatisfied` تُرضى
 * بـ`passed` وحده لكلّ بوّابةٍ مطلوبة. الوحدةُ نقيّة؛ تتبّعُ الإيصالات في المحرّك.
 */

export type GateName = "build" | "typecheck" | "tests" | "audit"
export type GateState = "passed" | "failed" | "unverified"

export interface GateReceipt {
  readonly gate: GateName
  readonly state: GateState
  /** ذيلُ آخر إيصالٍ فشل — للإنسان. */
  readonly evidence?: string
}

export interface GateTrack {
  /** هل نُفّذ فحصُ هذه البوّابة على الشيفرة الحاليّة (منذ آخر تعديلٍ مُبطِل)؟ */
  readonly ran: boolean
  readonly passed: boolean
  readonly evidence?: string
}

const LABEL: Readonly<Record<GateName, string>> = Object.freeze({ build: "البناء", typecheck: "الأنواع", tests: "الاختبارات", audit: "التدقيق" })
const STATE_LABEL: Readonly<Record<GateState, string>> = Object.freeze({ passed: "✓ نجح", failed: "✗ فشل", unverified: "○ لم يُفحص" })

export function gateState(track: GateTrack): GateState {
  if (!track.ran) return "unverified"
  return track.passed ? "passed" : "failed"
}

/** إيصالٌ لكلّ بوّابةٍ **مطلوبة** — غيرُ المطلوبة لا تُذكر (لا ضجيج، ولا ادّعاءَ فحصٍ لم يُطلب). */
export function gateReceipts(required: Readonly<Partial<Record<GateName, boolean>>>, tracks: Readonly<Partial<Record<GateName, GateTrack>>>): readonly GateReceipt[] {
  const order: readonly GateName[] = ["build", "typecheck", "tests", "audit"]
  const out: GateReceipt[] = []
  for (const gate of order) {
    if (required[gate] !== true) continue
    const track = tracks[gate] ?? { ran: false, passed: false }
    const state = gateState(track)
    out.push(Object.freeze({ gate, state, ...(state === "failed" && track.evidence !== undefined && track.evidence.length > 0 ? { evidence: track.evidence } : {}) }))
  }
  return Object.freeze(out)
}

/** يُرضى بـ`passed` وحده: الفاشلُ لا، و**غيرُ المفحوص لا** — الغيابُ رفضٌ لا إذن. */
export function acceptanceSatisfied(receipts: readonly GateReceipt[]): boolean {
  return receipts.every((r) => r.state === "passed")
}

const clip = (s: string, n: number): string => s.replace(/\s+/gu, " ").trim().slice(-n)

/** سطرُ الإيصال للمشغّل — فارغٌ حين لا بوّابةَ مطلوبة، بايتاً كما كان. */
export function acceptanceLine(receipts: readonly GateReceipt[]): string {
  if (receipts.length === 0) return ""
  const parts = receipts.map((r) => `${LABEL[r.gate]} ${STATE_LABEL[r.state]}${r.evidence !== undefined ? ` (${clip(r.evidence, 120)})` : ""}`)
  return `بوابات القبول: ${parts.join(" · ")}`
}

/** ما يُقال للنموذج عند بوّابةٍ لم تُرضَ: يفرّق الفشلَ عن الغياب كي لا يعيد فحصاً لم يفشل. */
export function gateShortfall(receipt: GateReceipt): string {
  return receipt.state === "failed"
    ? `آخرُ فحصٍ لـ${LABEL[receipt.gate]} **فشل** على الشيفرة الحاليّة${receipt.evidence !== undefined ? ` (${clip(receipt.evidence, 120)})` : ""} — أصلح السبب ثم أعد الفحص`
    : `${LABEL[receipt.gate]} **لم يُفحص** على الشيفرة الحاليّة — نفّذ الفحص أوّلاً، ولا تدّعِ نجاحاً لم يُقس`
}
