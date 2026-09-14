/**
 * ب6 — كومبيوتر-يوس على النظام (ويندوز): لقطةُ الشاشة، النوافذُ، التركيزُ، النقرُ، الكتابةُ، المفاتيحُ، التمرير — كما يفعل كلود وكوديكس
 * على سطح مكتب المستخدم، لكن بحرّيته وخصوصيته: كلُّ شيءٍ على جهازه، ولا لقطةَ تغادره إلا إلى نموذج الرؤية الذي اختاره.
 *
 * الطريق: PowerShell 5.1 المدمج + Win32 عبر `Add-Type` (user32: SendInput/SetCursorPos/EnumWindows/SetForegroundWindow) وSystem.Drawing
 * للّقطة — لا اعتمادَ يُنزَّل ولا تغييرَ في Rust (Cargo لجبهةٍ أخرى). النصُّ يُمرَّر base64 فلا اقتباسَ يُكسر ولا حقنَ أوامر.
 *
 * الحراسة تعيش في المحرّك لا هنا: مفتاحٌ مستقلّ `desktopControlEnabled` (مطفأٌ افتراضاً)، صنفُ موافقةٍ `outside-workspace` لكلّ فعل،
 * وحدُّ النافذة. هذه الوحدةُ نقيّةٌ إلا `powershellRunner` الذي يُحقن ويُبدَّل في الاختبار.
 *
 * ب6ب (مراجعةٌ عدائيّةٌ بأربع عدسات، ٣ عيوبٍ نجت من الدحض) — **الحدُّ يسبق الفعل، وفي اللحظة نفسِها**:
 * ١) كان حدُّ النافذة على النقر وحده: الكتابةُ والمفاتيحُ والتمرير تذهب إلى أيّ نافذةٍ في المقدّمة، والمقدّمةُ تُقرأ **بعد** وصول
 *    الحروف فتُروى ولا تُمنع. الآن **كلُّ فعلِ إدخالٍ يحتاج نافذةً مربوطة**، والسكربتُ نفسُه يتحقّق أنّ المقدّمة هي هي **قبل** أوّل
 *    حرف — في العمليّة ذاتها، فلا فجوةَ بين الفحص والفعل — ويعيد الفحصَ بعده فيقول إن تغيّرت أثناءه.
 * ٢) كانت إحداثيّاتُ النقر إحداثيّاتِ شاشة، واللقطةُ صورةَ الشاشة الافتراضيّة التي قد يكون أصلُها سالباً (شاشةٌ يسار الرئيسة):
 *    فنقرةٌ يقرؤها النموذج من الصورة تقع مزاحةً. الآن **الإحداثيّاتُ من زاوية النافذة المربوطة**، والمستطيلُ يُقرأ لحظةَ الحقن
 *    (نافذةٌ تحرّكت بين التركيز والنقر لا تُصيب مكاناً خاطئاً)، واللقطةُ افتراضاً **للنافذة وحدها** لا لسطح مكتب المستخدم كلِّه.
 * ٣) وكان مستطيلٌ سالبٌ (نافذةٌ على شاشةٍ يسار الرئيسة) يجعل كلَّ نقرةٍ فيها مرفوضةً للأبد: الإحداثيّةُ النسبيّةُ لا تكون سالبة.
 * وزيادةً: `SendInput` يُقاس عائدُه — حقنٌ حجبه النظام (نافذةٌ مرفوعةُ الصلاحيّة) كان يُروى نجاحاً، والآن يُقال «حُجب».
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

export type DesktopAction =
  | { readonly kind: "shot"; readonly scope: "auto" | "screen" }
  | { readonly kind: "windows" }
  | { readonly kind: "focus"; readonly title: string }
  | { readonly kind: "click"; readonly x: number; readonly y: number; readonly button: "left" | "right" | "double" }
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "key"; readonly combo: string }
  | { readonly kind: "scroll"; readonly direction: "up" | "down"; readonly count: number }
  // م6ب — شجرةُ الواجهة بـUI Automation: الطريقُ الحتميّ قبل الرؤية على واجهاتٍ لم يرها النموذج (أسماءُ الحقول والأزرار ومستطيلاتُها وأنماطُها).
  | { readonly kind: "ui"; readonly depth: number }
  | { readonly kind: "set"; readonly ref: number; readonly text: string }
  | { readonly kind: "press"; readonly ref: number }
  // م6و (مقيس 09-14 على المثبَّت): `run notepad` نفّذ سكربتَ غلاف Git Bash ففتح ملفّاً وأظهر «Pick an app» ولم يعرف النموذجُ بها —
  // `open` يُقلع البرنامجَ بـShellExecute، ينتظر نافذتَه الجديدة، يربطها، ويسمّي كلَّ نافذةٍ أخرى ظهرت (قائمةُ اختيار، حوار).
  | { readonly kind: "open"; readonly app: string }

/** عنصرٌ من شجرة UI Automation للنافذة المربوطة — المستطيلُ من زاوية النافذة (بكسلاتٌ فعليّة كاللقطة). */
export interface UiElement { readonly ref: number; readonly type: string; readonly name: string; readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly patterns: readonly string[]; readonly value?: string; readonly enabled: boolean; readonly password: boolean }

export interface WindowInfo { readonly hwnd: number; readonly pid: number; readonly title: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
/** النافذةُ المربوطة بـ`desk focus`: المقبضُ هو الحدّ، والمستطيلُ آخرُ ما قيس (يُعاد قياسُه لحظةَ الحقن). */
export interface DesktopBound { readonly hwnd: number; readonly title: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface DesktopRunner { run(script: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> }

/** أفعالُ الإدخال: تحتاج نافذةً مربوطةً وتحقّقاً من المقدّمة قبل الحقن. القراءةُ (لقطة/نوافذ/تركيز) لا. */
export const INPUT_KINDS: ReadonlySet<DesktopAction["kind"]> = new Set(["click", "type", "key", "scroll", "set", "press"] as const)

export const DESKTOP_USAGE = "الصيغة: desk open <برنامج|مسار> | desk shot [screen] | desk windows | desk focus <عنوان النافذة | pid:رقم> | desk ui [عمق] | desk set <مرجع> <نص> | desk press <مرجع> | desk click <x> <y> [right|double] | desk type <نص> | desk key <Enter|Tab|Esc|ctrl+s|alt+f4|win|…> | desk scroll <up|down> [عدد] — والإحداثيّاتُ من زاوية النافذة المركَّزة العليا اليسرى (بكسلاتٌ فعليّة كاللقطة)"
export const UI_DEFAULT_DEPTH = 8, UI_MAX_DEPTH = 14, UI_ELEMENT_CAP = 400
export const NEEDS_FOCUS = `لا نافذةَ مربوطة: ركّز نافذةً أوّلاً بـ«desk focus <جزءٌ من العنوان>» — الإدخالُ لا يُرسَل إلى «أيّ نافذةٍ في المقدّمة». ${DESKTOP_USAGE}`

/** أسماءُ المفاتيح ⇦ رموزُ Win32 الافتراضية. */
export const KEY_VK: Readonly<Record<string, number>> = Object.freeze({
  enter: 13, return: 13, tab: 9, esc: 27, escape: 27, backspace: 8, delete: 46, del: 46, space: 32, home: 36, end: 35, pageup: 33, pagedown: 34,
  up: 38, down: 40, left: 37, right: 39, win: 91, ctrl: 17, control: 17, alt: 18, shift: 16, insert: 45, printscreen: 44,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
})
const MODIFIERS = new Set([17, 18, 16, 91])

export function parseDesktopCommand(rest: string): DesktopAction | { readonly error: string } {
  const [head, ...tail] = rest.trim().split(/\s+/)
  // النصُّ يُؤخذ **خاماً** من بقيّة السطر لا مُعاداً بربط الكلمات: `tail.join(" ")` كان يطوي كلَّ فراغين إلى واحد
  // ويمنع السطرَ الجديد أصلاً (ففرعُ Enter في السكربت لا يُبلَغ) — فيُكتب غيرُ ما وافق عليه المستخدم.
  const raw = rest.replace(/^\s+/, "")
  const arg = raw.slice((head ?? "").length).replace(/^[^\S\r\n]+/, "").replace(/[\r\n]+$/, "")
  switch ((head ?? "").toLowerCase()) {
    case "shot": return { kind: "shot", scope: (tail[0] ?? "").toLowerCase() === "screen" ? "screen" : "auto" }
    case "windows": return { kind: "windows" }
    case "open": {
      const app = arg.replace(/^["'«»“”‘’`]+|["'«»“”‘’`]+$/gu, "").trim()
      if (app.length === 0) return { error: "desk open <اسمُ برنامج (notepad, mspaint, excel) أو مسارُ .exe/ملفّ>" }
      if (/[|&;<>^\r\n]/.test(app)) return { error: "desk open: اسمٌ أو مسارٌ واحد بلا رموز صدفة" }
      return { kind: "open", app: app.slice(0, 260) }
    }
    case "focus": {
      // م6د (مقيس 09-14 على المثبَّت): النموذجُ يقتبس العنوانَ `desk focus "notepad - Notepad"` فكانت الاقتباساتُ جزءاً من الإبرة ⇦ «no window matches» ثلاثَ مرّات.
      const title = arg.replace(/^["'«»“”‘’`]+|["'«»“”‘’`]+$/gu, "").trim()
      return title.length === 0 ? { error: DESKTOP_USAGE } : { kind: "focus", title: title.slice(0, 120) }
    }
    case "click": {
      const x = Number.parseInt(tail[0] ?? "", 10), y = Number.parseInt(tail[1] ?? "", 10)
      // نسبيّةٌ إلى زاوية النافذة: السالبُ خارجها بالتعريف، ولا مستطيلَ سالبَ الأصل يمنع النقر بعد اليوم.
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) return { error: "desk click يحتاج إحداثيّتين صحيحتين من زاوية النافذة: desk click <x> <y> [right|double]" }
      const button = tail[2]?.toLowerCase() === "right" ? "right" : tail[2]?.toLowerCase() === "double" ? "double" : "left"
      return { kind: "click", x, y, button }
    }
    case "type": return arg.length === 0 ? { error: "desk type يحتاج نصّاً" } : arg.length > 4000 ? { error: "desk type: حتى ٤٠٠٠ حرف" } : { kind: "type", text: arg }
    case "key": {
      const combo = arg.toLowerCase().replace(/\s+/g, "")
      if (combo.length === 0) return { error: DESKTOP_USAGE }
      const parts = combo.split("+")
      for (const p of parts) if (!(p in KEY_VK) && !/^[a-z0-9]$/.test(p)) return { error: `مفتاحٌ مجهول «${p.slice(0, 12)}» — ${DESKTOP_USAGE}` }
      return { kind: "key", combo }
    }
    case "scroll": {
      const direction = tail[0]?.toLowerCase() === "up" ? "up" : tail[0]?.toLowerCase() === "down" ? "down" : undefined
      if (direction === undefined) return { error: "desk scroll <up|down> [عدد]" }
      const count = Math.min(20, Math.max(1, Number.parseInt(tail[1] ?? "3", 10) || 3))
      return { kind: "scroll", direction, count }
    }
    // م6ب — شجرةُ الواجهة وحقولُها بالمرجع: `ui [عمق]` ثمّ `set u7 نصّ` / `press u3` (المرجعُ رقمٌ أو uرقم).
    case "ui": {
      const depth = Number.parseInt(tail[0] ?? "", 10)
      return { kind: "ui", depth: Number.isInteger(depth) ? Math.min(UI_MAX_DEPTH, Math.max(1, depth)) : UI_DEFAULT_DEPTH }
    }
    case "set": {
      const ref = Number.parseInt((tail[0] ?? "").replace(/^u/i, ""), 10)
      if (!Number.isInteger(ref) || ref < 1) return { error: "desk set <مرجعٌ من desk ui> <نص>" }
      const text = arg.slice((tail[0] ?? "").length).replace(/^[^\S\r\n]+/, "")
      if (text.length === 0) return { error: "desk set يحتاج نصّاً بعد المرجع" }
      if (text.length > 4000) return { error: "desk set: حتى ٤٠٠٠ حرف" }
      return { kind: "set", ref, text }
    }
    case "press": {
      const ref = Number.parseInt((tail[0] ?? "").replace(/^u/i, ""), 10)
      return !Number.isInteger(ref) || ref < 1 ? { error: "desk press <مرجعٌ من desk ui>" } : { kind: "press", ref }
    }
    default: return { error: DESKTOP_USAGE }
  }
}

const vkOf = (name: string): number => (name in KEY_VK ? KEY_VK[name]! : name.toUpperCase().charCodeAt(0))
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64")

/** رأسُ Win32 المشترك — يُعرَّف مرّةً لكلّ سكربت (كلُّ نداءٍ عمليّةُ PowerShell مستقلّة). */
export const WIN32_PRELUDE = `$ErrorActionPreference = 'Stop'
# م6 (مقيس 2026-09-14): خرجُ PowerShell إلى الأنبوب بترميز الطرفيّة (cp1256/OEM) فكانت عناوينُ النوافذ وأسماءُ الحقول العربيّة تصل «????» — UTF-8 قبل أوّل سطر.
[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8
$src = @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AbdoDesk {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  // عائدُ SendInput يُجمَع: حقنٌ حجبه النظام (UIPI/نافذةٌ مرفوعةُ الصلاحيّة) يعود بأقلّ ممّا طُلب — فلا يُروى نجاحاً.
  static uint asked = 0; static uint accepted = 0;
  static void Send(INPUT[] i) { asked += (uint)i.Length; accepted += SendInput((uint)i.Length, i, Marshal.SizeOf(typeof(INPUT))); }
  public static uint Asked() { return asked; }
  public static uint Accepted() { return accepted; }
  public static void KeyDown(ushort vk) { var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; Send(i); }
  public static void KeyUp(ushort vk) { var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.dwFlags = 2; Send(i); }
  public static void Unicode(char c) { var i = new INPUT[2]; i[0].type = 1; i[0].u.ki.wScan = c; i[0].u.ki.dwFlags = 4; i[1].type = 1; i[1].u.ki.wScan = c; i[1].u.ki.dwFlags = 6; Send(i); }
  public static void MouseButton(uint flags) { var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dwFlags = flags; Send(i); }
  public static void Wheel(int amount) { var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.mouseData = unchecked((uint)amount); i[0].u.mi.dwFlags = 0x0800; Send(i); }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  // قفلُ المقدّمة في ويندوز يمنع عمليّةً خلفيّةً من رفع نافذةٍ إلى الأمام (قيس: أوّلُ تركيزٍ نجح والثاني رُفض).
  // الطريقُ الموثَّق: وصلُ صفّ الإدخال بخيط النافذة الأمامية وخيط الهدف أثناء الرفع وحده، ثمّ فصلُه — والنتيجةُ **تُتحقَّق** لا تُفترض.
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint pidTarget; uint target = GetWindowThreadProcessId(h, out pidTarget);
    uint pidFront; uint front = GetWindowThreadProcessId(fg, out pidFront);
    uint me = GetCurrentThreadId();
    bool a1 = front != 0 && front != me && AttachThreadInput(me, front, true);
    bool a2 = target != 0 && target != me && AttachThreadInput(me, target, true);
    ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
    if (a2) AttachThreadInput(me, target, false);
    if (a1) AttachThreadInput(me, front, false);
    return GetForegroundWindow() == h;
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'AbdoDesk').Type) { Add-Type -TypeDefinition $src -Language CSharp | Out-Null }
# م6 (مقيس 2026-09-14 على شاشة 150٪): PowerShell غيرُ واعٍ بالـDPI فكان GetWindowRect منطقيّاً وCopyFromScreen فعليّاً — اللقطةُ تلتقط المنطقةَ الخطأ
# والنموذجُ ينقر في غير مكانه. الوعيُ بالـDPI أوّلَ السكربت يجعل المستطيلَ والمؤشّرَ واللقطةَ كلَّها بكسلاتٍ فعليّة.
try { if (-not [AbdoDesk]::SetProcessDpiAwarenessContext((New-Object IntPtr (-4)))) { [void][AbdoDesk]::SetProcessDPIAware() } } catch { try { [void][AbdoDesk]::SetProcessDPIAware() } catch { } }
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 6 }
`

const WINDOWS_LIST = `$list = New-Object System.Collections.Generic.List[object]
$cb = [AbdoDesk+EnumProc]{ param($h, $l)
  if ([AbdoDesk]::IsWindowVisible($h)) { $t = [AbdoDesk]::Title($h); if ($t.Length -gt 0) { $r = New-Object AbdoDesk+RECT; [void][AbdoDesk]::GetWindowRect($h, [ref]$r); $wpid = [uint32]0; [void][AbdoDesk]::GetWindowThreadProcessId($h, [ref]$wpid); if (($r.Right - $r.Left) -gt 0) { $list.Add([pscustomobject]@{ hwnd = [int64]$h; pid = [int]$wpid; title = $t; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }) } } }
  $true }
[void][AbdoDesk]::EnumWindows($cb, [IntPtr]::Zero)
`

/**
 * الحارسُ الذي يسبق كلّ حقن — **في السكربت نفسِه** لا في العمليّة السابقة: المقدّمةُ هي النافذةُ المربوطة، وإلّا لا يُحقن شيء.
 * ويقرأ مستطيلَها الآن (لا مستطيلَ التركيز القديم) فيبقى النقرُ في مكانه إن تحرّكت النافذة.
 */
const foregroundGuard = (hwnd: number, selfPids: readonly number[] = []): string => `$want = [IntPtr]${hwnd}
$fg = [AbdoDesk]::GetForegroundWindow()
# م6هـ (مقيس 09-14 على المثبَّت): نافذةُ عبدو كود نفسُها تعود إلى المقدّمة بين نداءين (عرضُ إيصال) فكان set/type يُرفض «focus moved (AbdoCode)».
# السارقُ إن كان تطبيقَنا (pid القشرة/المحرّك) فليس المستخدمَ: تُرفع النافذةُ المربوطة مرّةً ثمّ يُعاد الفحص؛ وغيرُه رفضٌ كما كان.
$selfPids = @(${selfPids.filter((p) => Number.isInteger(p) && p > 0).join(", ")})
if (([int64]$fg) -ne ${hwnd} -and $selfPids.Count -gt 0) { $fpid = [uint32]0; [void][AbdoDesk]::GetWindowThreadProcessId($fg, [ref]$fpid); if ($selfPids -contains [int]$fpid) { [void][AbdoDesk]::Focus($want); Start-Sleep -Milliseconds 150; $fg = [AbdoDesk]::GetForegroundWindow() } }
if (([int64]$fg) -ne ${hwnd}) { Out-Json @{ ok = $false; error = 'focus moved'; foreground = [AbdoDesk]::Title($fg) }; exit 0 }
$r = New-Object AbdoDesk+RECT
if (-not [AbdoDesk]::GetWindowRect($want, [ref]$r)) { Out-Json @{ ok = $false; error = 'window gone' }; exit 0 }
`

/** ذيلُ كلّ حقن: هل قبِل النظامُ كلَّ ما أُرسل، وهل بقيت المقدّمةُ هي هي حتى النهاية. */
const injectionTail = (extra: string): string => `$after = [AbdoDesk]::GetForegroundWindow()
$blocked = [AbdoDesk]::Accepted() -lt [AbdoDesk]::Asked()
$moved = ([int64]$after) -ne ([int64]$want)
Out-Json @{ ok = (-not $blocked -and -not $moved); blocked = $blocked; moved = $moved; asked = [AbdoDesk]::Asked(); accepted = [AbdoDesk]::Accepted(); foreground = [AbdoDesk]::Title($after)${extra} }
`

/** سكربتُ PowerShell لفعلٍ واحد — يُخرج سطرَ JSON أخيراً. النافذةُ المربوطة شرطٌ لكلّ فعلِ إدخال. */
export function desktopScript(action: DesktopAction, shotPath = "", bound?: DesktopBound, ui?: UiContext, selfPids: readonly number[] = []): string {
  switch (action.kind) {
    case "shot": {
      const path = shotPath.replace(/'/g, "''")
      // اللقطةُ الافتراضيّة **للنافذة المربوطة وحدها**: سطحُ مكتب المستخدم كلُّه لا يُصوَّر لأنّ الوكيل يريد زرّاً.
      if (bound !== undefined && action.scope !== "screen") {
        return `${WIN32_PRELUDE}Add-Type -AssemblyName System.Drawing
${foregroundGuard(bound.hwnd, selfPids)}$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Out-Json @{ ok = $false; error = 'window has no area' }; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size); $g.Dispose()
$bmp.Save('${path}', [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Out-Json @{ ok = $true; scope = 'window'; width = $w; height = $h; left = $r.Left; top = $r.Top; title = [AbdoDesk]::Title($want); path = '${path}' }
`
      }
      return `${WIN32_PRELUDE}Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
$bmp.Save('${path}', [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Out-Json @{ ok = $true; scope = 'screen'; width = $b.Width; height = $b.Height; left = $b.Left; top = $b.Top; path = '${path}' }
`
    }
    case "windows": return `${WIN32_PRELUDE}${WINDOWS_LIST}Out-Json @{ ok = $true; windows = @($list.ToArray()) }
`
    // م6و — الإقلاعُ بـShellExecute (لا بصدفة Git التي تحوّل notepad إلى سكربت غلاف)، ثمّ انتظارُ النافذة الجديدة وربطُها وتسميةُ ما ظهر معها.
    case "open": return `${WIN32_PRELUDE}${WINDOWS_LIST}$before = @{}; foreach ($w in $list) { $before[[string]$w.hwnd] = $true }
$app = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.app)}'))
$launchPid = 0; $err = ''
try { $p = Start-Process -FilePath $app -PassThru -ErrorAction Stop; if ($p) { $launchPid = [int]$p.Id } } catch { $err = $_.Exception.Message
  if ($app -notmatch '\\.[A-Za-z0-9]{1,4}$' -and $app -notmatch '[\\\\/]') { try { $p = Start-Process -FilePath ($app + '.exe') -PassThru -ErrorAction Stop; if ($p) { $launchPid = [int]$p.Id }; $err = '' } catch { $err = $_.Exception.Message } } }
if ($err.Length -gt 0) { Out-Json @{ ok = $false; error = ('could not start: ' + $err) }; exit 0 }
$fresh = @(); $deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
${WINDOWS_LIST}  $fresh = @($list | Where-Object { -not $before.ContainsKey([string]$_.hwnd) })
  if ($fresh.Count -gt 0) { Start-Sleep -Milliseconds 400; break }
}
$needle = [IO.Path]::GetFileNameWithoutExtension($app).ToLowerInvariant()
$existing = $false
if ($fresh.Count -eq 0) {
  # تطبيقٌ ذو نافذةٍ واحدة (مفكرةُ ويندوز ١١ تفتح تبويباً في نافذتها القائمة): تُربط النافذةُ القائمة بـpid الإقلاع أو بالاسم.
  $hit = $list | Where-Object { $_.pid -eq $launchPid } | Select-Object -First 1
  if ($null -eq $hit) { $hit = $list | Where-Object { $_.title.ToLowerInvariant().Contains($needle) } | Select-Object -First 1 }
  if ($null -eq $hit) { Out-Json @{ ok = $false; error = 'no new window appeared'; launchedPid = $launchPid }; exit 0 }
  $existing = $true
} else {
  $hit = $fresh | Where-Object { $_.pid -eq $launchPid } | Select-Object -First 1
  if ($null -eq $hit) { $hit = $fresh | Where-Object { $_.title.ToLowerInvariant().Contains($needle) } | Select-Object -First 1 }
  if ($null -eq $hit) { $hit = $fresh | Sort-Object { ($_.right - $_.left) * ($_.bottom - $_.top) } -Descending | Select-Object -First 1 }
}
$others = @($fresh | Where-Object { $_.hwnd -ne $hit.hwnd } | ForEach-Object { @{ title = $_.title; pid = $_.pid; hwnd = $_.hwnd } })
$raised = [AbdoDesk]::Focus([IntPtr]$hit.hwnd); Start-Sleep -Milliseconds 150
$fg = [AbdoDesk]::GetForegroundWindow()
$r = New-Object AbdoDesk+RECT; [void][AbdoDesk]::GetWindowRect([IntPtr]$hit.hwnd, [ref]$r)
Out-Json @{ ok = $true; focused = (([int64]$fg) -eq ([int64]$hit.hwnd)); existing = $existing; hwnd = $hit.hwnd; title = $hit.title; pid = $hit.pid; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; launchedPid = $launchPid; others = $others }
`
    case "focus": return `${WIN32_PRELUDE}${WINDOWS_LIST}$needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.title)}')).ToLowerInvariant()
$hit = if ($needle -match '^pid:(\\d+)$') { $wantPid = [int]$Matches[1]; $list | Where-Object { $_.pid -eq $wantPid } | Select-Object -First 1 } else { $list | Where-Object { $_.title.ToLowerInvariant().Contains($needle) } | Select-Object -First 1 }
if ($null -eq $hit) { $seen = @($list | Select-Object -First 15 | ForEach-Object { @{ title = $_.title; pid = $_.pid } }); Out-Json @{ ok = $false; error = 'no window matches'; count = $list.Count; windows = $seen }; exit 0 }
$raised = [AbdoDesk]::Focus([IntPtr]$hit.hwnd); Start-Sleep -Milliseconds 150
$fg = [AbdoDesk]::GetForegroundWindow()
if (([int64]$fg) -ne ([int64]$hit.hwnd)) { Out-Json @{ ok = $false; error = 'could not bring the window to the front'; raised = $raised; foreground = [AbdoDesk]::Title($fg) }; exit 0 }
$r = New-Object AbdoDesk+RECT; [void][AbdoDesk]::GetWindowRect([IntPtr]$hit.hwnd, [ref]$r)
Out-Json @{ ok = $true; hwnd = $hit.hwnd; title = $hit.title; pid = $hit.pid; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
`
    case "click": {
      const down = action.button === "right" ? "0x0008" : "0x0002", up = action.button === "right" ? "0x0010" : "0x0004"
      const times = action.button === "double" ? 2 : 1
      return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}$sx = $r.Left + ${action.x}; $sy = $r.Top + ${action.y}
if (${action.x} -ge ($r.Right - $r.Left) -or ${action.y} -ge ($r.Bottom - $r.Top)) { Out-Json @{ ok = $false; error = 'point is outside the window now'; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }; exit 0 }
[void][AbdoDesk]::SetCursorPos($sx, $sy); Start-Sleep -Milliseconds 40
$p = New-Object AbdoDesk+POINT
if (-not [AbdoDesk]::GetCursorPos([ref]$p)) { Out-Json @{ ok = $false; error = 'cursor position unreadable' }; exit 0 }
if ($p.X -ne $sx -or $p.Y -ne $sy) { Out-Json @{ ok = $false; error = 'the cursor did not reach the point'; x = $p.X; y = $p.Y }; exit 0 }
${Array.from({ length: times }, () => `[AbdoDesk]::MouseButton(${down}); [AbdoDesk]::MouseButton(${up})`).join("; Start-Sleep -Milliseconds 60; ")}
${injectionTail(`; x = $sx; y = $sy; button = '${action.button}'`)}`
    }
    case "type": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.text)}'))
foreach ($ch in $text.ToCharArray()) { if ($ch -eq "\`n") { [AbdoDesk]::KeyDown(13); [AbdoDesk]::KeyUp(13) } elseif ($ch -ne "\`r") { [AbdoDesk]::Unicode($ch) }; Start-Sleep -Milliseconds 8 }
${injectionTail("; chars = $text.Length")}`
    case "key": {
      const parts = action.combo.split("+")
      const vks = parts.map(vkOf)
      const mods = vks.filter((v) => MODIFIERS.has(v)), keys = vks.filter((v) => !MODIFIERS.has(v))
      return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}${mods.map((v) => `[AbdoDesk]::KeyDown(${v})`).join("; ")}${mods.length ? "; " : ""}${keys.map((v) => `[AbdoDesk]::KeyDown(${v}); [AbdoDesk]::KeyUp(${v})`).join("; ")}${mods.length ? "; " : ""}${[...mods].reverse().map((v) => `[AbdoDesk]::KeyUp(${v})`).join("; ")}
${injectionTail(`; combo = '${action.combo}'`)}`
    }
    case "scroll": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}for ($i = 0; $i -lt ${action.count}; $i++) { [AbdoDesk]::Wheel(${action.direction === "up" ? 120 : -120}); Start-Sleep -Milliseconds 30 }
${injectionTail(`; direction = '${action.direction}'; count = ${action.count}`)}`
    // م6ب — UI Automation: الطريقُ الحتميّ على واجهةٍ لم يرها النموذج — الأسماءُ والأنماطُ من النظام لا من الصورة، فلا DPI ولا لغةَ نافذةٍ تُزيحه.
    case "ui": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}${UIA_PRELUDE}
Walk-Ui $rootEl 1 ${action.depth} ${UI_ELEMENT_CAP}
$out = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $items.Count; $i++) { $out.Add((Describe-Ui $items[$i] ($i + 1) $r)) }
Out-Json @{ ok = $true; count = $items.Count; capped = ($items.Count -ge ${UI_ELEMENT_CAP}); elements = @($out.ToArray()); width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
`
    case "set": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}${UIA_PRELUDE}${locateUi(action.ref, ui!)}
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.text)}'))
$how = ''; $vp = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) { try { $el.SetFocus() } catch { }; $vp.SetValue($text); $how = 'value-pattern' }
else { try { $el.SetFocus() } catch { }; Start-Sleep -Milliseconds 80
  # الاستبدالُ لا الإلحاق: عنصرٌ بمقبضٍ أصليّ (Win32/WinForms) يُحدَّد كلُّه بـEM_SETSEL (Ctrl+A لا يعمل في TextBox متعدّد الأسطر — مقيس)، وغيرُه (WPF/Chromium) بـCtrl+A.
  $nh = [int64]$cur.NativeWindowHandle
  if ($nh -ne 0 -and $nowType -eq 'Edit') { [void][AbdoDesk]::SendMessage([IntPtr]$nh, 0x00B1, [IntPtr]::Zero, (New-Object IntPtr (-1))) } else { [AbdoDesk]::KeyDown(17); [AbdoDesk]::KeyDown(65); [AbdoDesk]::KeyUp(65); [AbdoDesk]::KeyUp(17) }
  Start-Sleep -Milliseconds 40; foreach ($ch in $text.ToCharArray()) { if ($ch -eq "\`n") { [AbdoDesk]::KeyDown(13); [AbdoDesk]::KeyUp(13) } elseif ($ch -ne "\`r") { [AbdoDesk]::Unicode($ch) }; Start-Sleep -Milliseconds 8 }; $how = 'typed' }
Start-Sleep -Milliseconds 150
$readback = $null; $vp2 = $null
if (-not $cur.IsPassword) { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp2)) { $readback = [string]$vp2.Current.Value } elseif ($nowType -eq 'Edit') { $readback = [string]$el.Current.Name } }
$verified = ($null -ne $readback) -and ($readback.Replace("\`r", '') -eq $text.Replace("\`r", ''))
$rb = if ($null -eq $readback) { $null } else { $readback.Substring(0, [Math]::Min(80, $readback.Length)) }
$blocked = [AbdoDesk]::Accepted() -lt [AbdoDesk]::Asked()
Out-Json @{ ok = (-not $blocked); blocked = $blocked; how = $how; verified = $verified; readback = $rb; password = [bool]$cur.IsPassword; name = $expName; type = $expType; foreground = [AbdoDesk]::Title([AbdoDesk]::GetForegroundWindow()) }
`
    case "press": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd, selfPids)}${UIA_PRELUDE}${locateUi(action.ref, ui!)}
$how = ''; $ip = $null; $tp = $null; $sp = $null; $ep = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); $how = 'invoke' }
elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { $tp.Toggle(); $how = 'toggle' }
elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $sp.Select(); $how = 'select' }
elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) { $ep.Expand(); $how = 'expand' }
else {
  $b = $cur.BoundingRectangle
  if ([double]::IsInfinity($b.X) -or $b.Width -le 0) { Out-Json @{ ok = $false; error = 'element has no clickable area and no invoke pattern' }; exit 0 }
  $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
  [void][AbdoDesk]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 40; [AbdoDesk]::MouseButton(0x0002); [AbdoDesk]::MouseButton(0x0004); $how = 'click-center'
}
Start-Sleep -Milliseconds 150
$blocked = [AbdoDesk]::Accepted() -lt [AbdoDesk]::Asked()
Out-Json @{ ok = (-not $blocked); blocked = $blocked; how = $how; name = $expName; type = $expType; foreground = [AbdoDesk]::Title([AbdoDesk]::GetForegroundWindow()) }
`
  }
}

/** رأسُ UI Automation: شجرةُ التحكّم للنافذة المربوطة، بعمقٍ وسقفٍ (النافذةُ الثقيلة لا تُغرق النموذج). */
const UIA_PRELUDE = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($want)
$items = New-Object System.Collections.Generic.List[object]
function Walk-Ui($el, $depth, $maxDepth, $cap) {
  $c = $walker.GetFirstChild($el)
  while ($null -ne $c -and $items.Count -lt $cap) {
    $items.Add($c)
    if ($depth -lt $maxDepth) { Walk-Ui $c ($depth + 1) $maxDepth $cap }
    $c = $walker.GetNextSibling($c)
  }
}
# نوعُ العنصر: UIA2 المُدار يرى عناصرَ WinForms/Win32 القديمة «Pane» بلا أنماط (مقيس: زرٌّ ومربّعُ نصّ صارا Pane) — صنفُ النافذة الأصليّ يسمّيها.
function Ui-Type($cur) {
  $t = $cur.ControlType.ProgrammaticName.Replace('ControlType.', '')
  if ($t -ne 'Pane' -and $t -ne 'Custom' -and $t -ne 'Window') { return $t }
  $cn = ([string]$cur.ClassName).ToUpperInvariant()
  if ($cn -match 'EDIT|RICHEDIT|TEXTBOX') { return 'Edit' }
  if ($cn -match 'COMBOBOX') { return 'ComboBox' }
  if ($cn -match 'LISTBOX|SYSLISTVIEW32|LISTVIEW') { return 'List' }
  if ($cn -match 'SYSTREEVIEW32|TREEVIEW') { return 'Tree' }
  if ($cn -match 'SYSTABCONTROL32|TABCONTROL') { return 'Tab' }
  if ($cn -match 'TRACKBAR') { return 'Slider' }
  if ($cn -match 'UPDOWN') { return 'Spinner' }
  if ($cn -match 'BUTTON') { return 'Button' }
  if ($cn -match 'STATIC|LABEL') { return 'Text' }
  return $t
}
function Describe-Ui($el, $i, $wr) {
  $cur = $el.Current
  $b = $cur.BoundingRectangle
  $pats = @(); foreach ($p in $el.GetSupportedPatterns()) { $pats += $p.ProgrammaticName.Replace('PatternIdentifiers.Pattern', '') }
  $type = Ui-Type $cur
  $val = $null
  if (-not $cur.IsPassword) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $val = [string]$vp.Current.Value }
    elseif ($type -eq 'Edit') { $val = [string]$cur.Name; $pats += 'Text' }
    if ($null -ne $val -and $val.Length -gt 80) { $val = $val.Substring(0, 80) }
  }
  $name = [string]$cur.Name
  if ($type -eq 'Edit' -and $name -eq $val) { $name = '' }
  $x = -1; $y = -1; $w = 0; $h = 0
  if (-not [double]::IsInfinity($b.X) -and $b.Width -gt 0) { $x = [int]($b.X - $wr.Left); $y = [int]($b.Y - $wr.Top); $w = [int]$b.Width; $h = [int]$b.Height }
  @{ ref = $i; type = $type; name = $name; id = [string]$cur.AutomationId; x = $x; y = $y; w = $w; h = $h; patterns = $pats; value = $val; enabled = [bool]$cur.IsEnabled; password = [bool]$cur.IsPassword }
}
`

/** تحديدُ العنصر بالمرجع: الشجرةُ تُمشى بالعمق نفسِه، ويُطابَق النوعُ والاسمُ اللذان رآهما النموذج — واجهةٌ تغيّرت تُرفض لا تُخمَّن. */
const locateUi = (ref: number, ui: UiContext): string => {
  const expect = ui.elements.find((e) => e.ref === ref)
  const expType = expect?.type ?? "", expName = expect?.name ?? ""
  return `Walk-Ui $rootEl 1 ${ui.depth} ${UI_ELEMENT_CAP}
$idx = ${ref - 1}
if ($idx -ge $items.Count) { Out-Json @{ ok = $false; error = 'ref beyond the tree (the UI changed) - run desk ui again'; count = $items.Count }; exit 0 }
$el = $items[$idx]; $cur = $el.Current
$expType = '${expType.replace(/'/g, "''")}'; $expName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(expName)}'))
$nowType = Ui-Type $cur
$nameOk = ($nowType -eq 'Edit') -or ([string]$cur.Name -eq $expName)
if ($nowType -ne $expType -or -not $nameOk) { Out-Json @{ ok = $false; error = 'the UI changed since desk ui - run desk ui again'; nowType = $nowType; nowName = [string]$cur.Name }; exit 0 }
`
}

/** سياقُ `desk ui` الأخير: العمقُ الذي مُشيت به الشجرة والعناصرُ بمراجعها — `set`/`press` يطابقان عليه. */
export interface UiContext { readonly depth: number; readonly elements: readonly UiElement[] }

/** سطرٌ للنموذج عن عنصرٍ واحد؛ العناصرُ الهيكليّة بلا اسمٍ ولا نمطٍ ولا قيمة تُطوى (المراجعُ تبقى ثابتة لأنّها فهرسُ الشجرة الكاملة). */
export const renderUiElement = (e: UiElement): string => `u${e.ref} [${e.type}]${e.name.length > 0 ? ` «${e.name.slice(0, 60)}»` : ""}${e.id.length > 0 ? ` #${e.id.slice(0, 40)}` : ""}${e.value !== undefined ? ` = "${e.value.replace(/\r?\n/g, "⏎")}"` : ""}${e.x >= 0 ? ` @(${e.x},${e.y} ${e.w}×${e.h})` : " (خارج الشاشة)"}${e.patterns.length > 0 ? ` {${e.patterns.join(",")}}` : ""}${e.enabled ? "" : " (معطّل)"}${e.password ? " (كلمة مرور — لا تُقرأ)" : ""}`
const INTERESTING_TYPES = new Set(["Edit", "Button", "CheckBox", "RadioButton", "ComboBox", "List", "ListItem", "MenuItem", "Menu", "Tab", "TabItem", "Hyperlink", "Document", "Slider", "Spinner", "TreeItem", "DataItem", "SplitButton"])
export const uiElementWorthShowing = (e: UiElement): boolean => INTERESTING_TYPES.has(e.type) || e.name.length > 0 || e.value !== undefined || e.patterns.some((p) => /^(Invoke|Value|Toggle|SelectionItem|ExpandCollapse)$/.test(p))

/** المشغّلُ الحقيقيّ: PowerShell 5.1 بلا ملفّ شخصيّ، السكربتُ مشفَّراً (-EncodedCommand، UTF-16LE base64) — لا وسيطاً يُقتبس ولا stdin يضيع (قيس: `-Command -` عاد صامتاً من Bun). */
export const powershellRunner: DesktopRunner = {
  async run(script, timeoutMs) {
    const exe = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const encoded = Buffer.from(script, "utf16le").toString("base64")
    const child = Bun.spawn([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* انتهى */ } }, timeoutMs)
    try {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      return { code, stdout, stderr, timedOut }
    } finally { clearTimeout(timer) }
  },
}

const lastJson = (stdout: string): Record<string, unknown> | undefined => {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"))
  if (lines.length === 0) return undefined
  try { return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown> } catch { return undefined }
}

export interface DesktopResult { readonly text: string; readonly shot?: { readonly path: string; readonly scope: "window" | "screen" }; readonly windows?: readonly WindowInfo[]; readonly bound?: DesktopBound; readonly elements?: readonly UiElement[]; readonly ok: boolean }

/**
 * المهلةُ من حجم العمل لا رقماً واحداً: `desk type` ينام ٨ms لكلّ حرف، فألفا حرفٍ تتجاوز العشرين ثانية —
 * كانت المهلةُ تقتل العمليّة **وسط الحقن** فيُروى فشلٌ والنصفُ الأوّل في المستند. (عيبٌ نجا من الدحض.)
 */
export const timeoutFor = (action: DesktopAction): number => {
  switch (action.kind) {
    case "type": return 20_000 + action.text.length * 30
    case "scroll": return 20_000 + action.count * 400
    case "shot": return 40_000
    case "ui": return 45_000
    case "open": return 30_000
    case "set": return 25_000 + action.text.length * 30
    default: return 20_000
  }
}

/** حدُّ النافذة: الإحداثيّةُ نسبيّةٌ إلى زاويتها، فما تجاوز عرضَها أو ارتفاعَها خارجُها — والسالبُ مرفوضٌ في التحليل. */
export const withinWindow = (x: number, y: number, b: DesktopBound): boolean => x < b.right - b.left && y < b.bottom - b.top

/** لقطاتُ سطح المكتب لا تتراكم على قرص المستخدم: يُبقى أحدثُ `keep` ويُحذف ما قبلها — وملفّاتُنا وحدها بالاسم. */
export function pruneShots(dir: string, keep: number): number {
  let removed = 0
  try {
    const ours = readdirSync(dir).filter((n) => /^desk-\d+\.png$/.test(n)).sort()
    for (const name of ours.slice(0, Math.max(0, ours.length - keep))) { try { rmSync(join(dir, name), { force: true }); removed += 1 } catch { /* مستعملٌ أو مُزال */ } }
  } catch { /* لا مجلّد بعد */ }
  return removed
}

/** عمليّاتُنا نحن — المحرّكُ وأبوه وقشرةُ سطح المكتب (`ABDO_DESKTOP_OWNER_PID`): نافذةٌ منها في المقدّمة ليست «المستخدمَ يعمل» فتُرفع المربوطةُ فوقها. */
export const defaultSelfPids = (): readonly number[] => [process.pid, process.ppid, Number.parseInt(process.env.ABDO_DESKTOP_OWNER_PID ?? "", 10)].filter((p) => Number.isInteger(p) && p > 0)

export const NEEDS_UI ="لا شجرةَ واجهةٍ بعد: شغّل «desk ui» أوّلاً ثمّ استعمل مراجعَه (u1، u2…) في set/press."

export async function runDesktop(action: DesktopAction, options: { shotsDir: string; runner?: DesktopRunner; bound?: DesktopBound; ui?: UiContext; selfPids?: readonly number[]; knownHwnds?: readonly number[]; timeoutMs?: number; keepShots?: number }): Promise<DesktopResult> {
  const runner = options.runner ?? powershellRunner
  const bound = options.bound
  // **الغيابُ رفض**: بلا نافذةٍ مربوطة لا يُحقن إدخالٌ في «أيّ نافذةٍ في المقدّمة» — والحدُّ يُفحص قبل أن يُبنى السكربت.
  if ((INPUT_KINDS.has(action.kind) || action.kind === "ui") && bound === undefined) return { ok: false, text: NEEDS_FOCUS }
  // م6ب — المرجعُ من شجرةٍ رآها النموذج في هذه النافذة، وإلّا فلا تخمين.
  if (action.kind === "set" || action.kind === "press") {
    if (options.ui === undefined) return { ok: false, text: NEEDS_UI }
    if (!options.ui.elements.some((e) => e.ref === action.ref)) return { ok: false, text: `مرجعٌ غير معروف u${action.ref} — آخرُ «desk ui» أعطى ${options.ui.elements.length} عنصراً؛ أعد desk ui.` }
  }
  if (action.kind === "click" && !withinWindow(action.x, action.y, bound!)) return { ok: false, text: `رُفضت النقرة (${action.x},${action.y}): خارج نافذة «${bound!.title.slice(0, 60)}» (${bound!.right - bound!.left}×${bound!.bottom - bound!.top}) — الإحداثيّاتُ من زاويتها العليا اليسرى` }
  let shotPath = ""
  if (action.kind === "shot") {
    mkdirSync(options.shotsDir, { recursive: true })
    pruneShots(options.shotsDir, Math.max(0, (options.keepShots ?? 20) - 1))
    shotPath = join(options.shotsDir, `desk-${Date.now()}.png`)
  }
  const out = await runner.run(desktopScript(action, shotPath, bound, options.ui, options.selfPids ?? defaultSelfPids()), options.timeoutMs ?? timeoutFor(action))
  const json = lastJson(out.stdout)
  // انقطاعٌ بالمهلة وسط حقنٍ ليس فشلاً نظيفاً: بعضُ الإدخال قد يكون وصل، فيُقال ذلك بدل «فشل» يغري بإعادةٍ تُكرّره.
  if (out.timedOut === true && INPUT_KINDS.has(action.kind)) return { ok: false, text: `انقطع ${action.kind} بعد المهلة: **قد يكون جزءٌ من الإدخال وصل** نافذة «${bound!.title.slice(0, 60)}» — تحقّق من حالتها قبل الإعادة (لا تُعِد الأمر كما هو).` }
  if (json === undefined || json.ok !== true) {
    const reason = typeof json?.error === "string" && json.error.length > 0 ? json.error : (out.stderr.trim().split("\n")[0] ?? "").trim() || `exit ${out.code}`
    const foreground = typeof json?.foreground === "string" && json.foreground.length > 0 ? ` (المقدّمةُ الآن: «${json.foreground.slice(0, 60)}»)` : ""
    // حُجب الحقنُ أو تحرّكت المقدّمةُ أثناءه: يُقال بلا تجميل — فالإدخالُ الذي لم يصل لا يُروى نجاحاً.
    if (json?.blocked === true) return { ok: false, text: `رُفض ${action.kind}: حجب النظامُ الإدخال (${json.accepted}/${json.asked}) — النافذةُ الأمامية غالباً مرفوعةُ الصلاحيّة، وعبدو لا يرفع صلاحيّته${foreground}.` }
    // م6د (مقيس 09-14 على المثبَّت): النموذجُ يخمّن العنوانَ («Untitled - Notepad») وهو «notepad - Notepad» — الرفضُ يحمل النوافذَ الظاهرة فلا تخمينَ ثانياً ولا جولةَ desk windows.
    if (action.kind === "focus" && json?.error === "no window matches" && Array.isArray(json.windows)) {
      const seen = (json.windows as Array<{ title?: unknown; pid?: unknown }>).map((w) => `«${String(w.title ?? "").slice(0, 60)}» pid ${Number(w.pid)}`).join("، ")
      return { ok: false, text: `لا نافذةَ يطابق عنوانُها «${action.title.slice(0, 60)}». النوافذُ الظاهرة الآن (${json.count}): ${seen} — اختر جزءاً من عنوانٍ منها أو «desk focus pid:<رقم>».` }
    }
    if (json?.moved === true) return { ok: false, text: `تحرّكت المقدّمةُ أثناء ${action.kind}: قد يكون جزءٌ من الإدخال وصل النافذةَ المربوطة${foreground} — أعد التركيز وتحقّق قبل الإعادة.` }
    return { ok: false, text: `فشل ${action.kind}: ${reason.slice(0, 200)}${foreground}` }
  }
  switch (action.kind) {
    case "shot": {
      const scope = json.scope === "window" ? "window" : "screen"
      const where = scope === "window" ? `نافذة «${String(json.title ?? bound?.title ?? "").slice(0, 60)}»` : "كامل الشاشة"
      const hint = scope === "window" ? "الإحداثيّاتُ من زاوية الصورة العليا اليسرى = زاويةُ النافذة." : "للنظر فقط: النقرُ والكتابةُ يحتاجان نافذةً مركَّزة (desk focus)."
      return { ok: true, text: `لقطةُ ${where} ${json.width}×${json.height} حُفظت على قرصك: ${shotPath} — ${hint} تصل نموذجَ الرؤية في النداء التالي إن ضُبط.`, shot: { path: shotPath, scope } }
    }
    case "windows": {
      const windows = (Array.isArray(json.windows) ? json.windows : []) as WindowInfo[]
      // م6و — ما ظهر منذ آخر عدٍّ يُسمّى «جديدة»: قائمةُ اختيارٍ أو حوارٌ طرأ بعد فعلِ النموذج لا يُترك له أن يكتشفه بالمقارنة.
      const known = options.knownHwnds === undefined ? undefined : new Set(options.knownHwnds)
      const fresh = known === undefined ? [] : windows.filter((w) => !known.has(w.hwnd))
      const line = (w: WindowInfo) => `- «${w.title.slice(0, 80)}» [${w.right - w.left}×${w.bottom - w.top}] pid ${w.pid}${known !== undefined && !known.has(w.hwnd) ? " (جديدة)" : ""}`
      const head = fresh.length > 0 ? `${windows.length} نافذة، منها ${fresh.length} ظهرت منذ آخر عدّ (قد تكون قائمةَ اختيار برنامج أو حواراً — ركّزها بـpid واقرأها بـdesk ui):\n` : `${windows.length} نافذة:\n`
      return { ok: true, windows, text: windows.length === 0 ? "لا نوافذَ ظاهرة." : `${head}${windows.slice(0, 40).map(line).join("\n")}` }
    }
    case "open": {
      const next: DesktopBound = { hwnd: Number(json.hwnd), title: String(json.title ?? ""), left: Number(json.left), top: Number(json.top), right: Number(json.right), bottom: Number(json.bottom) }
      const others = (Array.isArray(json.others) ? json.others : []) as Array<{ title?: unknown; pid?: unknown }>
      const alsoNew = others.length === 0 ? "" : `\n⚠ ظهرت معها ${others.length} نافذةٌ أخرى: ${others.map((o) => `«${String(o.title ?? "").slice(0, 60)}» pid ${Number(o.pid)}`).join("، ")} — إن كانت قائمةَ «اختيار برنامج» أو حواراً فركّزها بـ«desk focus pid:<رقم>» واقرأها بـdesk ui واضغط الخيارَ المطلوب، ثمّ عد إلى «${next.title.slice(0, 40)}».`
      const how = json.existing === true ? "كانت مفتوحةً من قبل فرُبطت" : "أُقلعت ورُبطت نافذتُها الجديدة"
      const focused = json.focused === true ? "" : " (لم تصل إلى المقدّمة — desk focus قبل الإدخال)"
      return { ok: true, bound: next, text: `${how}: «${next.title.slice(0, 80)}» (${next.right - next.left}×${next.bottom - next.top}) pid ${Number(json.pid)}${focused} — التالي: desk ui.${alsoNew}` }
    }
    case "focus": {
      const next: DesktopBound = { hwnd: Number(json.hwnd), title: String(json.title ?? ""), left: Number(json.left), top: Number(json.top), right: Number(json.right), bottom: Number(json.bottom) }
      return { ok: true, bound: next, text: `ركّزتُ نافذة «${next.title.slice(0, 80)}» (${next.right - next.left}×${next.bottom - next.top}) — الإدخالُ يذهب إليها وحدها، والإحداثيّاتُ من زاويتها العليا اليسرى.` }
    }
    case "click": return { ok: true, text: `نقرتُ ${action.button} على (${action.x},${action.y}) داخل «${String(json.foreground ?? "").slice(0, 60)}».` }
    case "type": return { ok: true, text: `كتبتُ ${json.chars} حرفاً في «${String(json.foreground ?? "").slice(0, 80)}».` }
    case "key": return { ok: true, text: `ضغطتُ ${action.combo} في «${String(json.foreground ?? "").slice(0, 80)}».` }
    case "scroll": return { ok: true, text: `مرّرتُ ${action.direction} ×${action.count} في «${String(json.foreground ?? "").slice(0, 60)}».` }
    case "ui": {
      const raw = (Array.isArray(json.elements) ? json.elements : []) as Array<Record<string, unknown>>
      const elements: UiElement[] = raw.map((e) => ({
        ref: Number(e.ref), type: String(e.type ?? ""), name: String(e.name ?? ""), id: String(e.id ?? ""), x: Number(e.x), y: Number(e.y), w: Number(e.w), h: Number(e.h),
        patterns: (Array.isArray(e.patterns) ? e.patterns : []).map(String), ...(typeof e.value === "string" ? { value: e.value } : {}), enabled: e.enabled !== false, password: e.password === true,
      }))
      const shown = elements.filter(uiElementWorthShowing)
      const head = `شجرةُ واجهة «${bound!.title.slice(0, 60)}» (${json.width}×${json.height}): ${elements.length} عنصراً${json.capped === true ? " (بلغ السقف — زد التركيزَ على جزءٍ أو قلّل العمق)" : ""}، منها ${shown.length} ذاتُ معنى. المرجعُ يُستعمل في «desk set uN نصّ» و«desk press uN»؛ الإحداثيّاتُ من زاوية النافذة كاللقطة.`
      return { ok: true, elements, text: elements.length === 0 ? `${head}\nلا عناصرَ يعلنها التطبيق (واجهةٌ مرسومة كـcanvas؟) — استعمل desk shot ونموذجَ الرؤية ثمّ desk click.` : `${head}\n${shown.map(renderUiElement).join("\n")}` }
    }
    case "set": {
      const how = json.how === "value-pattern" ? "بنمط القيمة" : "بالكتابة"
      const where = `«${String(json.name ?? "").slice(0, 60)}» [${String(json.type ?? "")}]`
      if (json.password === true) return { ok: true, text: `ضبطتُ ${where} ${how} — حقلُ كلمة مرور، لا قراءةَ راجعة.` }
      if (json.verified === true) return { ok: true, text: `ضبطتُ ${where} ${how} — والقراءةُ الراجعة مطابقة.` }
      if (typeof json.readback === "string") return { ok: false, text: `كتبتُ في ${where} ${how} لكنّ القراءةَ الراجعة غيرُ مطابقة: «${json.readback.slice(0, 80)}» — قد يحوّل الحقلُ النصَّ أو يرفضه؛ افحص بـdesk ui.` }
      return { ok: true, text: `ضبطتُ ${where} ${how} — الحقلُ لا يعلن قيمته، تحقّق بـdesk ui أو desk shot.` }
    }
    case "press": {
      const how = { invoke: "بنمط الاستدعاء", toggle: "بالتبديل", select: "بالاختيار", expand: "بالتوسيع", "click-center": "بنقرةٍ في مركزه" }[String(json.how)] ?? String(json.how)
      return { ok: true, text: `ضغطتُ «${String(json.name ?? "").slice(0, 60)}» [${String(json.type ?? "")}] ${how} — المقدّمةُ الآن «${String(json.foreground ?? "").slice(0, 60)}». أعد desk ui لترى الأثر.` }
    }
  }
}
