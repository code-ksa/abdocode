/**
 * 10-08 (مقيس على مهمّة الموقع): «scroll down» رمى «Browser control command timed out» من قناة CDP فصعد الاستثناءُ إلى الدور فأنهاه رفضاً
 * بعد ٦ دقائق. أداةٌ تتعطّل = فشلُ أداةٍ يراه النموذجُ ويتصرّف (يعيد، أو يفتح الصفحةَ ثانيةً، أو يختار طريقاً آخر)، لا موتُ الدور.
 * الإلغاءُ (AbortError) وحده يصعد كما هو. `undefined` = يُعاد رميُه.
 */
import { redactSecretValues, sweepResidualSecrets } from "./secret-command-guard"

export interface ToolCrash { readonly output: string; readonly verdict: { readonly ok: false; readonly reason: "tool_failed"; readonly denied: false; readonly detail: string }; readonly event: string }

export function toolCrashResult(word: string, error: unknown): ToolCrash | undefined {
  if (error instanceof Error && error.name === "AbortError") return undefined
  const message = sweepResidualSecrets(redactSecretValues(String(error instanceof Error ? error.message : error)).text).text.slice(0, 400)
  const hint = /browser|cdp|target closed|websocket/iu.test(message) ? " — قناةُ المتصفّح لم تستجب: أعد الأمرَ، أو open <الرابط> لإعادة فتح الصفحة." : " — أعد المحاولة أو اختر طريقاً آخر."
  return {
    output: `✕ «${word}» تعطّل: ${message}${hint}`,
    verdict: { ok: false, reason: "tool_failed", denied: false, detail: message.slice(0, 160) },
    event: `⚠ «${word}» تعطّل: ${message.slice(0, 160)} — يُعاد إلى النموذج فشلَ أداةٍ لا يُنهي الدور`,
  }
}
