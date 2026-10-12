/**
 * 10-08 (مقيس على abdo-router): «✓ سبرنت 6 مكتمل … كلُّ السبرنتات مغلقة» وفي الشجرة 49 ملفّاً معدّلاً بلا إيداعٍ واحد منذ خطّ الأساس —
 * والمهمّةُ طلبت «إيداعاً بكلّ سبرنت»؛ عملُ ستّة سبرنتات كان على القرص وحده. إغلاقُ آخر سبرنتٍ في مستودع git يُسمّي ما لم يُودَع.
 * `status` = خرجُ `git status --porcelain`. `""` = لا ملاحظة.
 */
export function uncommittedNote(status: string): string {
  const files = status.split(/\r?\n/u).map((l) => l.slice(3).trim()).filter((f) => f.length > 0)
  if (files.length === 0) return ""
  const shown = files.slice(0, 6).join("، ")
  return `\n⚠ ${files.length} ملفّاً غيرَ مودَع في الشجرة (${shown}${files.length > 6 ? "، …" : ""}) — المهمّةُ تُسلَّم مودَعة: أودِع ملفّاتِك بأسمائها (git add <الملفّات> ثمّ git commit -m "…") — لا git add -A، ولا دفعَ بلا إذن المالك.`
}
