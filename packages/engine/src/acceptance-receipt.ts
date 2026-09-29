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
/** `unproven` (09-28): الفحصُ نُفّذ وخرج برمز 0 لكنّ خرجَه لا يحمل دليلاً (اختبارٌ يطبع «ok» بلا عدّ) — ليس «فشل» فيُطلب
 * إصلاحُ ما لم يسقط، ولا «نجح» فالغيابُ رفضٌ لا إذن؛ المطلوبُ دليلٌ في الخرج. مقيس: نموذجٌ أعاد ادّعاءَ الاكتمال مرّتين
 * بلا أداة حين قيل له إنّ `node test.js` (رمز 0، «ok») **فشل**. */
/** `preexisting` (09-29): التدقيقُ فشل على اعتمادياتٍ **لم تمسّها هذه الجولة** (لا write package.json ولا install/add/update) —
 * ثغراتٌ سابقةٌ للتعديل تُبلَّغ ولا تحجب؛ فدفعُ النموذج إلى `npm audit fix --force` تغييرٌ كاسرٌ قرارُه للمالك. مقيس على
 * openrouter-clone: بناءٌ ✓ وprobe 2/2 ✓ ثمّ وقف الدور acceptance-pending على glob CLI الموروثة. */
export type GateState = "passed" | "failed" | "unverified" | "unproven" | "preexisting"

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
  /** نُفّذ وخرج برمز 0 لكنّ الخرجَ بلا دليل (لا عدَّ نجاحٍ ولا فشل) — يُروى «بلا دليل» لا «فشل». */
  readonly unproven?: boolean
  /** فشل على اعتمادياتٍ لم تُمسّ في هذه الجولة — يُروى «سابق» لا «فشل»، ولا يحجب. */
  readonly preexisting?: boolean
}

const LABEL: Readonly<Record<GateName, string>> = Object.freeze({ build: "البناء", typecheck: "الأنواع", tests: "الاختبارات", audit: "التدقيق" })
const STATE_LABEL: Readonly<Record<GateState, string>> = Object.freeze({ passed: "✓ نجح", failed: "✗ فشل", unverified: "○ لم يُفحص", unproven: "△ بلا دليل", preexisting: "△ سابق — اعتمادياتٌ لم تُمسّ" })

export function gateState(track: GateTrack): GateState {
  if (!track.ran) return "unverified"
  if (track.passed) return "passed"
  if (track.preexisting === true) return "preexisting"
  return track.unproven === true ? "unproven" : "failed"
}

/** إيصالٌ لكلّ بوّابةٍ **مطلوبة** — غيرُ المطلوبة لا تُذكر (لا ضجيج، ولا ادّعاءَ فحصٍ لم يُطلب). */
export function gateReceipts(required: Readonly<Partial<Record<GateName, boolean>>>, tracks: Readonly<Partial<Record<GateName, GateTrack>>>): readonly GateReceipt[] {
  const order: readonly GateName[] = ["build", "typecheck", "tests", "audit"]
  const out: GateReceipt[] = []
  for (const gate of order) {
    if (required[gate] !== true) continue
    const track = tracks[gate] ?? { ran: false, passed: false }
    const state = gateState(track)
    out.push(Object.freeze({ gate, state, ...((state === "failed" || state === "unproven" || state === "preexisting") && track.evidence !== undefined && track.evidence.length > 0 ? { evidence: track.evidence } : {}) }))
  }
  return Object.freeze(out)
}

/** يُرضى بـ`passed` وحده: الفاشلُ لا، و**غيرُ المفحوص لا** — الغيابُ رفضٌ لا إذن. و`preexisting` (09-29) فشلٌ **مقيس** على
 * ما لم تمسّه الجولة: يُبلَّغ في السطر ولا يحجب التسليم. */
export function acceptanceSatisfied(receipts: readonly GateReceipt[]): boolean {
  return receipts.every((r) => r.state === "passed" || r.state === "preexisting")
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
  if (receipt.state === "preexisting") return `${LABEL[receipt.gate]} فشل على اعتمادياتٍ لم تمسّها هذه الجولة${receipt.evidence !== undefined ? ` (${clip(receipt.evidence, 120)})` : ""} — يُبلَّغ ولا يحجب؛ تحديثُ الاعتماديات قرارٌ مستقلّ`
  if (receipt.state === "unproven") {
    const ask = receipt.gate === "tests"
      ? "اجعل الاختبارَ يطبع عددَ ما نجح (مثل «6 passed») أو استخدم `node --test`/عدّاءَ المشروع، ثمّ أعد التشغيل"
      : "اجعل الفحصَ يطبع نتيجتَه صراحةً ثمّ أعده"
    return `آخرُ فحصٍ لـ${LABEL[receipt.gate]} خرج برمز 0 لكن **بلا دليلٍ في الخرج**${receipt.evidence !== undefined ? ` (${clip(receipt.evidence, 120)})` : ""} — لم يفشل، لكنّ الغيابَ ليس نجاحاً: ${ask}`
  }
  return receipt.state === "failed"
    ? `آخرُ فحصٍ لـ${LABEL[receipt.gate]} **فشل** على الشيفرة الحاليّة${receipt.evidence !== undefined ? ` (${clip(receipt.evidence, 120)})` : ""} — أصلح السبب ثم أعد الفحص`
    : `${LABEL[receipt.gate]} **لم يُفحص** على الشيفرة الحاليّة — نفّذ الفحص أوّلاً، ولا تدّعِ نجاحاً لم يُقس`
}
