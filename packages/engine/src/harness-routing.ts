/** S8 — توجيه الهارنس والنموذج: لكلّ عائلةٍ قضبانها، صغيرها وكبيرها.
 *
 * عائلة الهارنس في `@abdo/prompting` (native/claude/codex/deepseek/qwen)
 * كانت **صفر استيراد** — بيانات لا يقرؤها أحد، ونجاح qwen9b مصادفة توافق
 * لا سياسة. هذا الموجّه يختار الهارنس بحسب مرجع النموذج ومهمة الدور، ويقرّر
 * تسامح إصلاح النداء المشوّه (الصغيرة تحتاجه، عبدو الأصلي لا). قرارٌ حتميّ
 * من المرجع، لا تخمين.
 */
import { HarnessRegistry } from "@abdo/prompting"

export type TaskKind = "chat" | "build" | "fix" | "review" | "plan"
export type HarnessRole = "system" | "builder" | "verifier" | "recovery"

export interface HarnessChoice {
  readonly harnessId: string
  /** يُسمح بإصلاح نداءٍ جزئيّ بدل رفضه — للنماذج الصغيرة/المفكّرة. */
  readonly repairPartialCalls: boolean
  readonly reason: string
}

/** يختار الهارنس من عائلة النموذج. المرجع مثل «ollama/qwen9b-gpu-64k». */
export function selectHarness(modelRef: string): HarnessChoice {
  const ref = modelRef.toLowerCase()
  const available = new Set(HarnessRegistry.ids())
  const pick = (id: string, fallback = "abdo-native"): string => (available.has(id) ? id : fallback)

  // عبدو الأصلي: عقده الأدوات مغلقة، لا إصلاح جزئيّ.
  if (/empero|abdo|native/.test(ref)) {
    return { harnessId: pick("abdo-native"), repairPartialCalls: false, reason: "عبدو الأصلي: عقد أدواتٍ مغلق" }
  }
  // Qwen وأمثاله من الصغيرة المحلية: مخطط متسامح وإصلاح النداء المشوّه.
  if (/qwen|gemma|phi|mistral|llama|deepseek-r|-r1|distill/.test(ref)) {
    // deepseek-style هارنس المفكّرة (room-to-think + recovery)؛ qwen-style للبقية.
    const isReasoner = /deepseek-r|-r1|qwq|reason|distill/.test(ref)
    return { harnessId: pick(isReasoner ? "deepseek-style" : "qwen-style"), repairPartialCalls: true, reason: isReasoner ? "نموذج مفكّر: room-to-think + recovery" : "نموذج محليّ صغير: مخطط متسامح وإصلاح النداء" }
  }
  if (/claude|anthropic/.test(ref)) return { harnessId: pick("claude-style"), repairPartialCalls: false, reason: "عائلة Claude" }
  if (/gpt|codex|openai|o[134]-/.test(ref)) return { harnessId: pick("codex-style"), repairPartialCalls: false, reason: "عائلة GPT/Codex" }
  // مجهول: المفكّر المتسامح أأمن من العقد المغلق مع نموذجٍ لا نعرف قدرته.
  return { harnessId: pick("qwen-style"), repairPartialCalls: true, reason: "عائلة غير معروفة: افتراضٌ متسامح" }
}

/**
 * تعليمة الدور الإضافية بحسب المهمة والهارنس — تُلحق بنظام الدور.
 * `review` تعطي عدسة المراجع (S7)، و`recovery` تعطي «قل ما ظننته غلطاً ثم
 * أعِد، ولا تكرّر النداء نفسه».
 */
export function harnessInstruction(modelRef: string, role: HarnessRole): string {
  const profile = HarnessRegistry.get(selectHarness(modelRef).harnessId)
  if (profile === undefined) return ""
  const doc = profile.document as unknown as { instructions?: { scope?: string; text?: string }[]; naming?: { assistant?: string } }
  const found = doc.instructions?.find((i) => i.scope === role)
  if (found?.text === undefined) return ""
  return found.text.replace(/\{assistant\}/g, doc.naming?.assistant ?? "المساعد")
}
