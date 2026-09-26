/**
 * جاهزيّةُ WSLg مقيسةً — **بلا شيءٍ من قناتنا**، كي لا يُخفي عطلُ القناة نفسَه
 * بتخطٍّ صامت. مِلفٌّ واحد لأنّ اختبارين يقرآن الجاهزيّة نفسَها: نسختان تفترقان
 * في أوّل تعديل، فيصير أحدهما يتخطّى والآخر يحمرّ على الشاشة نفسِها.
 *
 * والتمييزُ مقصود:
 * - `wslgTools`            = WSL وأدواتُها حاضرة (xdotool، import، pyatspi، DISPLAY).
 * - `wslgHasWindowManager` = الشاشةُ تملك مديرَ نوافذَ EWMH، أي أنّ خاصيّةَ
 *                            `_NET_ACTIVE_WINDOW` **موجودةٌ على الجذر** فيمكن
 *                            إثباتُ التصدّر أصلاً.
 *
 * مقيس 2026-09-26: WSLg هنا أدواتٌ بلا مديرِ نوافذ — النافذةُ تُعرض ويجدها
 * xdotool، و`getactivewindow` يردّ «XGetWindowProperty[_NET_ACTIVE_WINDOW]
 * failed». فالقناةُ ترفض بحقّ (لا حقنَ بلا إثبات تصدّر)، والاختبارُ الحيُّ كان
 * يحمرّ كذباً على المنتَج ٣٦ ثانيةً في كلّ سويتة.
 *
 * ⚠ **الفحصُ لا يفتح نافذةً ولا يُظهر طرفيّة.** نسخةٌ أولى منه أقلعت نافذةَ GTK
 * عبر WSLg لتقيس التنشيط، فسرقت المقدّمةَ من الاختبار التالي (`desk-window-live`)
 * فأحمرّ بـ«المقدّمةُ الآن: Terminal» — بوّابةُ جاهزيّةٍ تفسد ما بعدها. والخاصيّةُ
 * تُسأل على الجذر بلا نافذةٍ إطلاقاً، وهو المِحكُّ نفسُه الذي يستعمله المنتَج
 * (`no_wm()` في `desktop-linux.ts`)، و`windowsHide` يمنع وميضَ الطرفيّة.
 */
import { wslExe } from "../../src/desktop-linux"

export const WSLG_DISTRO = process.env.ABDO_TEST_WSL_DISTRO ?? "Ubuntu-24.04"

export const wslRun = (cmd: string, timeout = 20_000): { ok: boolean; out: string } => {
  try {
    const r = Bun.spawnSync([wslExe(), "-d", WSLG_DISTRO, "-e", "bash", "-lc", cmd], { timeout, stdin: "ignore", windowsHide: true })
    return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).replace(/ /gu, "") }
  } catch {
    return { ok: false, out: "" }
  }
}

/** الأدواتُ حاضرة — شرطٌ لازمٌ غيرُ كاف. */
export const wslgTools = (): boolean =>
  process.platform === "win32" && wslRun("test -n \"$DISPLAY\" && command -v xdotool && command -v import && python3 -c 'import pyatspi, gi'").ok

/**
 * هل يمكن إثباتُ التصدّر على هذه الشاشة؟ سؤالٌ للجذر بلا نافذة: غيابُ
 * `_NET_ACTIVE_WINDOW` يعني لا مديرَ نوافذَ EWMH ⇒ لا تنشيطَ يُثبَت.
 *
 * وثلاثُ حالاتٍ لا اثنتان: **فشلٌ لسببٍ لم نقِسه لا يُترجَم تخطّياً** — التخطّي
 * يخفي انكسارَ القناة، فالمجهولُ يُترك ليعمل ويقول بنفسه. (مقيس أنّ الفحص
 * السلبيّ يمرّ بطريقين: الحارسُ عمل، أو المسارُ لم يُستدعَ.)
 */
export const wslgActivation = (): { readonly provable: boolean; readonly why: string } => {
  const r = wslRun("export DISPLAY=:0; xdotool getactivewindow", 20_000)
  if (r.ok) return { provable: true, why: "getactivewindow ردّ بمعرّفٍ — الشاشةُ تملك مديرَ نوافذ" }
  if (r.out.includes("_NET_ACTIVE_WINDOW")) return { provable: false, why: "لا مديرَ نوافذ: خاصيّةُ _NET_ACTIVE_WINDOW غائبةٌ عن الجذر" }
  return { provable: true, why: `فشلٌ لسببٍ غيرِ مقيس (${r.out.slice(0, 120)}) — يُترك الاختبارُ يعمل ليقول بنفسه` }
}
