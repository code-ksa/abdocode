import { classifyModelFailure, type ModelFailure } from "@abdo/model-gateway"

/** Transport failures are control flow, never assistant answers. Provider bodies
 * and raw exception messages may contain request data, so UI text is bounded
 * and derived only from the failure category. */
export class ModelRequestFailure extends Error {
  override readonly name = "ModelRequestFailure"
  readonly action: "provider-settings" | "local-runtime" | "retry" | "shorten-context"

  constructor(
    readonly provider: string,
    readonly local: boolean,
    readonly failure: ModelFailure,
  ) {
    super(`${provider}: ${failure.reason}`)
    this.action = failure.kind === "credential" || failure.kind === "invalid-request" ? "provider-settings"
      : failure.kind === "context-limit" ? "shorten-context"
      : local && failure.kind === "transport" ? "local-runtime" : "retry"
  }

  publicMessage(language: string | undefined): string {
    const ar = language === "ar"
    const details = this.failure.kind === "credential"
      ? ar ? "اعتماد المزوّد غير متاح أو مرفوض. افتح الإعدادات ← المزوّدون لربط الخزنة والتحقق من الاتصال." : "The provider credential is unavailable or rejected. Open Settings → Providers to connect your vault and check the connection."
      : this.local && this.failure.kind === "transport"
      ? ar ? "تعذّر الاتصال بالمشغّل المحلي. تحقّق من تشغيله ومن عنوانه في الإعدادات ← المزوّدون، ثم أعد المحاولة." : "Could not connect to the local runtime. Check that it is running and verify its address in Settings → Providers, then retry."
      : this.failure.kind === "cancelled"
      ? ar ? "أُلغي الطلب. يمكنك المتابعة برسالة جديدة." : "The request was cancelled. You can continue with a new message."
      : this.failure.kind === "rate-limited"
      ? ar ? "بلغ المزوّد حد الاستخدام. انتظر تجدد الحد أو اختر نموذجاً آخر ثم أعد المحاولة." : "The provider reached its usage limit. Wait for the limit to reset or choose another model, then retry."
      : this.failure.kind === "invalid-request"
      ? ar ? "رفض المزوّد الطلب. تحقّق من عنوان الخدمة واسم النموذج في الإعدادات ← المزوّدون." : "The provider rejected the request. Check the service address and model name in Settings → Providers."
      : this.failure.kind === "context-limit"
      ? ar ? "يتجاوز الطلب سياق النموذج. اختصر الرسالة أو اختر نموذجاً بسياق أكبر." : "The request exceeds the model context. Shorten the message or choose a model with a larger context."
      : this.failure.kind === "protocol"
      ? ar ? "انقطع رد النموذج أو لم يصل بصيغة صالحة. حُفظ ما وصل؛ يمكنك إعادة المحاولة." : "The model response was interrupted or invalid. Received output was preserved; you can retry."
      : ar ? "تعذّر الوصول إلى المزوّد. تحقّق من الاتصال ثم أعد المحاولة." : "Could not reach the provider. Check the connection, then retry."
    // رقمُ الحالة آمنٌ ويُغني عن التخمين (مقيس 09-14: «رفض المزوّد الطلب» بلا رقمٍ أخفى سببَ رفض إنفيديا).
    return `${this.provider}: ${details}${this.failure.status === undefined ? "" : ` (HTTP ${this.failure.status})`}`
  }
}

export function modelRequestFailure(provider: string, local: boolean, input: Parameters<typeof classifyModelFailure>[0]): ModelRequestFailure {
  return new ModelRequestFailure(provider, local, classifyModelFailure(input))
}
