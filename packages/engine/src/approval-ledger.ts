/**
 * دفتر الموافقات — مفرداتُ سطرَي «السؤال» و«القرار» في مصدرٍ واحد.
 *
 * طلبُ الموافقة كان إطاراً عابراً وحده: يظهر في المحادثة، ولا أثر له في
 * الدفتر الدائم. فإن سقطت القشرة أو أُعيد تشغيل المحرّك لم يبقَ ما يقول
 * **ماذا سُئل** و**بمَ أُجيب** — وهذه هي بالضبط اللحظة التي يجب أن تُروى.
 * هنا يُصاغ السطران، وتُصدَّر بادئةُ القرار ليطويَها فولد القشرة نفسه: نصٌّ
 * واحد لا اثنان.
 *
 * الوحدة **خالصة**: لا `node:` ولا DOM ولا حالة. القشرة تستوردها كما
 * يستوردها المحرّك (تُحزَم في `desktop/ui/approval-mount.js` — حزمةُ الميزة
 * التي تحمل مُخفِّضها الخالص ومساهمتَها في مِرساة القشرة معاً).
 */

/** ما يقوله القرار — والمقاطعة قرارٌ مسمّى لا صمت. */
export type ApprovalDecision = "approved" | "denied" | "interrupted"

/** بادئة سطر السؤال. لا تتقاطع مع بادئة القرار أبداً (يثبته اختبار). */
export const APPROVAL_ASKED_PREFIX = "🔐 طلب موافقة"
/** بادئة سطر القرار — القشرة تطوي عليها، فهي عقدٌ لا زينة. */
export const APPROVAL_DECIDED_PREFIX = "🔐 قرار الموافقة: "

/** نصُّ كل قرارٍ بالعربية — مصدرٌ واحد للكتابة وللقراءة العكسية. */
const DECISION_TEXT: Readonly<Record<ApprovalDecision, string>> = Object.freeze({
  approved: "سُمح",
  denied: "رُفض",
  interrupted: "أُلغي بالمقاطعة",
})

export interface ApprovalAsk {
  readonly request: string
  /** صنف الأثر كما تسمّيه القشرة (`RequestKind`) — يُنقل نصّاً لا يُعاد تصنيفه. */
  readonly cls: string
  readonly mode: string
}

export const approvalAskedLine = (ask: ApprovalAsk): string =>
  `${APPROVAL_ASKED_PREFIX} [${ask.cls}] في نمط ${ask.mode}: ${ask.request}`

export const approvalDecidedLine = (decided: { readonly request: string; readonly decision: ApprovalDecision }): string =>
  `${APPROVAL_DECIDED_PREFIX}${DECISION_TEXT[decided.decision]} — ${decided.request}`

/**
 * القراءة العكسية للقشرة: سطرُ دفترٍ ⇒ قرارُه، أو `undefined` إن لم يكن سطر
 * قرارٍ أصلاً. الطيُّ على النصّ المكتوب هنا لا على تصنيفٍ ثانٍ يمكن أن ينزلق.
 */
export const decisionOfLine = (payload: unknown): ApprovalDecision | undefined => {
  if (typeof payload !== "string" || !payload.startsWith(APPROVAL_DECIDED_PREFIX)) return undefined
  const tail = payload.slice(APPROVAL_DECIDED_PREFIX.length)
  for (const [decision, text] of Object.entries(DECISION_TEXT) as [ApprovalDecision, string][]) {
    if (tail.startsWith(`${text} — `) || tail === text) return decision
  }
  return undefined
}
