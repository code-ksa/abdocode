/**
 * سلّمُ الانقطاع التلقائيّ — أمرُ المالك 2026-09-28: «نظامٌ ذكيّ أوّل ما يفشل الـAPI يبدّل تلقائياً بلا توقّف،
 * يستعمل الأقوى ولو خلص ينزل للأقرب فالأقرب».
 *
 * سلّمُ المالك (`modelLadder`) إن ضُبط يبقى الحاكم. بلا سلّمٍ كان الدورُ يموت باسم المزوّد عند 503/انقطاع؛ الآن يُبنى
 * سلّمٌ من **البدائل المتاحة بمفتاح** مرتّبةً من الأقدر إلى الأقرب، ولا يُخترع نموذجٌ لا مفتاحَ له. النموذجُ الحاليّ
 * أوّلُ درجة (فالصعودُ درجةً واحدة = أقوى بديلٍ متاح)، والدرجاتُ التي استُهلكت في هذا الدور تُستبعد كي لا يعود
 * السلّمُ إلى مزوّدٍ سقط للتوّ.
 */
import type { ModelRung } from "@abdo/providers"

/** ترتيبُ القوّة — من الأقدر إلى الأخفّ؛ المراجعُ بصيغة عبدو كود `<مزوّد>/<نموذج>` (نماذجُ NIM تحمل منظّمتها). */
export const FALLBACK_ORDER: readonly string[] = Object.freeze([
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  "openrouter/anthropic/claude-sonnet-4.5",
  "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "anthropic/claude-sonnet-4-5",
  "nvidia/nvidia/nemotron-4-340b-instruct",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "openai/gpt-4o",
  "qwen-token-plan/qwen3.8-max",
  "openrouter/meta-llama/llama-3.3-70b-instruct",
  "qwen-token-plan/qwen3.7-plus",
  "deepseek/deepseek-v4-pro",
  "nvidia/nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  "deepseek/deepseek-v4-flash",
])

export interface FallbackDeps {
  /** هل للمزوّد مفتاحٌ (أو هو محلّيّ)؟ — يُقرأ من الخزنة المشحونة لا يُفترض. */
  readonly keyKnown: (providerId: string) => boolean
  /** يحلّ المرجعَ إلى مزوّدٍ ونموذج، أو undefined لمرجعٍ لا يُعرف. */
  readonly parseRef: (ref: string) => { readonly provider: string; readonly model: string } | undefined
}

/**
 * السلّمُ لهذا النداء: [الحاليّ، البديل ١، البديل ٢، …] بلا المستبعَدين. يعيد [] حين لا بديلَ بمفتاح — فيعود الفشلُ باسمه كما كان.
 */
export function fallbackLadder(current: string, exclude: ReadonlySet<string>, deps: FallbackDeps): readonly ModelRung[] {
  const alternatives = FALLBACK_ORDER.filter((ref) => {
    if (ref === current || exclude.has(ref)) return false
    const parsed = deps.parseRef(ref)
    return parsed !== undefined && deps.keyKnown(parsed.provider)
  })
  if (alternatives.length === 0) return Object.freeze([])
  return Object.freeze([
    Object.freeze({ ref: current, why: "النموذجُ المختار" }),
    ...alternatives.map((ref, index) => Object.freeze({ ref, why: `البديل ${index + 1} تلقائياً — الأقدرُ المتاح بمفتاح` })),
  ])
}

/** المراجعُ التي صُعِد عليها في هذا الدور (attemptId بصيغة `outage:<ref>`) — تُستبعد من السلّم التالي. */
export function spentRefs(spentAttempts: readonly string[]): ReadonlySet<string> {
  return new Set(spentAttempts.filter((id) => id.startsWith("outage:")).map((id) => id.slice("outage:".length)))
}
