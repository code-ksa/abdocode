/**
 * سلّم النماذج — **التصعيد بفشلٍ مثبت، لا بتقدير**.
 *
 * ما كان قائماً قبل هذا الملفّ (مقيس 2026-09-06): `classifyModelLane` يختار
 * الحارة **مرّةً واحدة من نصّ الطلب**، فإن أخطأ التقدير بقي الدورُ كلُّه على
 * النموذج الخطأ. وفي المقابل `@abdo/memory` يحمل تصعيداً ناضجاً **للاستراتيجية**
 * (`must_change` / `escalate`) — مختبَراً ولا يستدعيه المحرّك. فالفجوة ليست في
 * فكرة التصعيد بل في أنّها لا تصل إلى **اختيار النموذج**.
 *
 * وهذه الوحدة تسدّها بقاعدةٍ واحدة: **ابدأ من أرخص درجةٍ تفي، ولا تصعد إلا
 * بدليلِ فشلٍ مقيس** — وسلّم الأدوات عندنا يقول ذلك حرفاً: «يُصعَد بفشلٍ مثبتٍ
 * للدرجة الأدنى».
 *
 * ## القاعدة الحاكمة: «لم يُفحص» ليست «فشل»
 *
 * `Verdict` في محرّك التحقّق ثلاثيّ عمداً: `passed` و`failed` و**`unverified`**.
 * والتصعيد على `unverified` تصعيدٌ **على الجهل**: لم نفحص، فلا ندري، فندفع أكثر.
 * وهو أسوأ من عدم التصعيد لأنّه يشتري ثقةً لم تُقس، **ويخفي أنّ الفحص نفسه
 * معطَّل** — وهو بالضبط «الأخضر قد يعني لم يحدث شيء» مقلوباً. فيُردّ هنا
 * بسببٍ مسمّى (`not_verified`) يفرّقه عن `passed`، كي يعالج النداءُ الحالتين
 * على اختلافهما بدل أن يبتلعهما «لا تصعيد».
 *
 * ## لا تصعيدَ بلا سطرٍ يُكتب
 *
 * كلُّ صعودٍ يخرج ومعه `evidence` — أي أنّ الإيصال **لا يستطيع** أن يذكر صعوداً
 * بلا دليله: البنية نفسها تمنعه، فلا يُترك ذلك لانضباط الكاتب.
 *
 * الوحدة **نقيّة**: لا شبكة، ولا قرص، ولا وقتٍ من عندها، ولا استيرادَ حزمةٍ
 * جديدة (المدخلات موصوفةٌ بنيوياً كي لا تُضاف تبعيةٌ إلى `@abdo/providers`).
 */

/** درجةٌ في السلّم: مرجعُ نموذجٍ وسببُ وجوده فيها. الترتيب: الأرخص أولاً. */
export interface ModelRung {
  readonly ref: string
  /** لماذا هذه الدرجة — يُعرض في الإيصال، لا يُخترع عند العرض. */
  readonly why: string
}

/** ما يصحّ أن يكون دليلَ فشل. «لم يُفحص» ليست منها — عمداً. */
export type EvidenceKind = "gate_failed" | "tool_refused" | "plan_rebutted"

export interface EscalationEvidence {
  readonly kind: EvidenceKind
  /** ما جرى فعلاً: «bun test → 3 حمراء»، لا «الاختبار فشل». */
  readonly detail: string
  /** المحاولةُ التي وقع فيها الفشل — بها تُمنع مضاعفةُ الصعود بدليلٍ واحد. */
  readonly attemptId: string
}

export interface LadderState {
  readonly ref: string
  /** المحاولاتُ التي صُعِد بها فعلاً — لا تُعاد. */
  readonly spentAttempts: readonly string[]
}

export type Escalation =
  | { readonly kind: "escalated"; readonly state: LadderState; readonly from: string; readonly to: string; readonly why: string; readonly evidence: EscalationEvidence }
  /** بلغ أعلى السلّم ولا يزال يفشل — يُقال ولا يُصمت عنه. */
  | { readonly kind: "exhausted"; readonly state: LadderState; readonly why: string; readonly evidence: EscalationEvidence }
  /** دليلٌ استُهلك من قبل: الصعودُ وقع مرّةً ولا يتكرّر بالدليل نفسه. */
  | { readonly kind: "already_spent"; readonly state: LadderState; readonly why: string }
  /** بلا دليل: fail-closed. الغيابُ رفضٌ لا إذن. */
  | { readonly kind: "refused"; readonly state: LadderState; readonly why: string }

/** أرخصُ درجةٍ في السلّم — نقطةُ البدء دائماً. */
export function startOf(ladder: readonly ModelRung[]): LadderState | undefined {
  const first = ladder[0]
  return first === undefined ? undefined : Object.freeze({ ref: first.ref, spentAttempts: Object.freeze([]) })
}

/**
 * صعودُ درجةٍ واحدة — بدليل، ومرّةً واحدة لكل محاولة.
 *
 * الترتيب هنا جزءٌ من المعنى: يُفحص الدليلُ أولاً (بلا دليلٍ لا شيء يقع ولو كان
 * السلّم منتهياً)، ثمّ استهلاكُه، ثمّ سقفُ السلّم.
 */
export function climb(
  state: LadderState,
  ladder: readonly ModelRung[],
  evidence: EscalationEvidence | undefined,
): Escalation {
  if (evidence === undefined) {
    return Object.freeze({ kind: "refused", state, why: "لا صعود بلا دليل فشلٍ مقيس" })
  }
  if (state.spentAttempts.includes(evidence.attemptId)) {
    return Object.freeze({ kind: "already_spent", state, why: `الدليل «${evidence.attemptId}» صُعِد به من قبل` })
  }
  const index = ladder.findIndex((rung) => rung.ref === state.ref)
  const next = index < 0 ? undefined : ladder[index + 1]
  const spentAttempts = Object.freeze([...state.spentAttempts, evidence.attemptId])
  if (next === undefined) {
    return Object.freeze({
      kind: "exhausted",
      state: Object.freeze({ ref: state.ref, spentAttempts }),
      why: index < 0 ? `النموذج «${state.ref}» ليس في السلّم` : `«${state.ref}» أعلى السلّم ولا يزال يفشل`,
      evidence,
    })
  }
  return Object.freeze({
    kind: "escalated",
    state: Object.freeze({ ref: next.ref, spentAttempts }),
    from: state.ref,
    to: next.ref,
    why: `${evidence.kind}: ${evidence.detail} ⇦ ${next.why}`,
    evidence,
  })
}

/** نتيجةُ التحقّق كما يخرجها `@abdo/verification` — موصوفةٌ بنيوياً لا مستورَدة. */
export interface VerificationLike {
  readonly verdict: "passed" | "failed" | "unverified"
  readonly failed: readonly { readonly id: string; readonly evidence: string; readonly detail?: string }[]
  readonly why: string
}

export type EvidenceRead =
  | { readonly kind: "evidence"; readonly evidence: EscalationEvidence }
  /** نجح فعلاً — لا حاجة للصعود. */
  | { readonly kind: "passed"; readonly why: string }
  /** **لم يُفحص** — لا يُصعَد على الجهل، ولا يُخلط بالنجاح. */
  | { readonly kind: "not_verified"; readonly why: string }

/**
 * جسرُ التحقّق ⇦ الدليل. هو الموضع الوحيد الذي يقرّر «أهذا فشلٌ يُصعَّد عليه؟»،
 * فيُقرأ ويُختبر في مكانٍ واحد بدل أن يتكرّر الحكم عند كل نداء.
 */
export function evidenceFrom(result: VerificationLike, attemptId: string): EvidenceRead {
  if (result.verdict === "passed") return Object.freeze({ kind: "passed", why: result.why })
  if (result.verdict === "unverified") {
    return Object.freeze({ kind: "not_verified", why: `لم يُفحص: ${result.why} — لا صعود على الجهل` })
  }
  const first = result.failed[0]
  const detail = first === undefined
    ? result.why
    : `${first.id}: ${first.evidence}${first.detail === undefined ? "" : ` — ${first.detail}`}`
  return Object.freeze({ kind: "evidence", evidence: Object.freeze({ kind: "gate_failed", detail, attemptId }) })
}

/** سطرُ الإيصال — صعودٌ بلا سببٍ مكتوبٍ لا يمرّ من هنا. */
export function receiptLine(outcome: Escalation): string {
  switch (outcome.kind) {
    case "escalated":
      return `صعود: ${outcome.from} ⇦ ${outcome.to} — ${outcome.why}`
    case "exhausted":
      return `سقف السلّم عند ${outcome.state.ref} — ${outcome.why} (${outcome.evidence.detail})`
    case "already_spent":
      return `بلا صعود — ${outcome.why}`
    case "refused":
      return `بلا صعود — ${outcome.why} (${outcome.state.ref})`
  }
}
