/** A partial model reply may be displayed, but must never become a tool call. */
export const modelOutputViolation = (finishReason: string | undefined, interrupted = false): string | undefined => {
  if (interrupted) return "رُفض إخراج النموذج: انقطع البث أو أُوقف الدور؛ لم يُنفّذ أي اقتراح جزئي. أعد اقتراح أداة واحدة كاملة فقط."
  if (finishReason === "length" || finishReason === "max_tokens") {
    return "رُفض إخراج النموذج: بلغ حد التوليد قبل اكتمال الرد؛ لم يُنفّذ أي اقتراح جزئي. اختصر الرد وأخرج أداة واحدة كاملة، ولا تسرد قوائم ملفات طويلة."
  }
  return undefined
}
