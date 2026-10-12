/**
 * 10-10 (مقيس في مهمّة n8n على deepseek-v4-pro): بعد كلّ أداةٍ يرسل المحرّكُ للنموذج سطرَ متابعة («هذه آخرُ نتائج حزمة القراءة…»،
 * «واصل هدف المستخدم وخطته…») — والنموذجُ ينسخه أحياناً في آخر محتوى الملفّ الذي يكتبه، فيرفض حارسُ الصياغة ملفَّ tsx («Parse error
 * عند السطر 230») ويعيد النموذجُ الكتابةَ كاملة. نصُّ المحرّك نفسِه لا ينتمي إلى ملفّ مستخدمٍ أبداً: يُقطع من أوّل سطرٍ يبدأ به حتى النهاية،
 * ويُقال ذلك في الإيصال. Pure.
 */
const ENGINE_LINES = [
  "هذه آخرُ نتائج حزمة القراءة",
  "هذه آخر نتائج حزمة القراءة",
  "واصل هدف المستخدم",
  "نتيجة الأداة «",
  "نجاح أداة واحدة لا يعني اكتمال المهمة",
  "نجاحُ قراءةٍ لا يعني اكتمال المهمة",
  "للكتابة ضع محتوى الملف الحقيقي بعد <<<",
]

export function stripEngineEcho(content: string): { text: string; stripped: number } {
  const lines = content.split("\n")
  const at = lines.findIndex((line) => { const t = line.trimStart(); return ENGINE_LINES.some((marker) => t.startsWith(marker)) })
  if (at < 0) return { text: content, stripped: 0 }
  const kept = lines.slice(0, at).join("\n").replace(/\s+$/u, "")
  return { text: kept.length > 0 ? `${kept}\n` : "", stripped: lines.length - at }
}
