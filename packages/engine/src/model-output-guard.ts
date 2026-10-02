/** A partial model reply may be displayed, but must never become a tool call. */
export const modelOutputViolation = (finishReason: string | undefined, interrupted = false, partial = ""): string | undefined => {
  if (interrupted) return "رُفض إخراج النموذج: انقطع البث أو أُوقف الدور؛ لم يُنفّذ أي اقتراح جزئي. أعد اقتراح أداة واحدة كاملة فقط."
  if (finishReason === "length" || finishReason === "max_tokens") {
    const target = truncatedWriteTarget(partial)
    if (target !== undefined) return truncatedWriteLine(target)
    return "رُفض إخراج النموذج: بلغ حد التوليد قبل اكتمال الرد؛ لم يُنفّذ أي اقتراح جزئي. اختصر الرد وأخرج أداة واحدة كاملة، ولا تسرد قوائم ملفات طويلة."
  }
  return undefined
}

/**
 * 10-02 — مقيس حيّاً: كتابةُ صفحةٍ كاملة (25 ألف حرف) قُطعت عند حدّ التوليد مرّتين متتاليتين، وفي كلٍّ منهما «اختصر الرد» —
 * فأعاد النموذجُ الكتابةَ الكاملةَ نفسَها: عشرُ دقائق بلا أثر. الردُّ المقطوعُ وهو يكتب ملفّاً يُسمّى ملفُّه ويُعطى البديل.
 */
export const truncatedWriteTarget = (partial: string): string | undefined =>
  /(?:^|\n)[ \t]*(?:نفّ?ذ\s*:\s*|⚙\s*)?write\s+(\S+)\s+<<</u.exec(partial)?.[1]

export const truncatedWriteLine = (target: string): string =>
  `رُفض إخراج النموذج: بلغ حدّ التوليد وهو يكتب «${target}» كاملاً — الملفُّ أطولُ من ردٍّ واحد، ولم يُكتب شيء. لا تُعِد كتابتَه كاملاً: غيّر ما يلزم بـedit (مرساةٌ قصيرة ⇦ نصٌّ جديد)، أو اكتب بـwrite هيكلاً أقصر ثمّ أضف أقسامَه بـedit واحداً واحداً.`
