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

export interface WindowInfo { readonly hwnd: number; readonly pid: number; readonly title: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
/** النافذةُ المربوطة بـ`desk focus`: المقبضُ هو الحدّ، والمستطيلُ آخرُ ما قيس (يُعاد قياسُه لحظةَ الحقن). */
export interface DesktopBound { readonly hwnd: number; readonly title: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface DesktopRunner { run(script: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> }

/** أفعالُ الإدخال: تحتاج نافذةً مربوطةً وتحقّقاً من المقدّمة قبل الحقن. القراءةُ (لقطة/نوافذ/تركيز) لا. */
export const INPUT_KINDS: ReadonlySet<DesktopAction["kind"]> = new Set(["click", "type", "key", "scroll"] as const)

export const DESKTOP_USAGE = "الصيغة: desk shot [screen] | desk windows | desk focus <عنوان النافذة> | desk click <x> <y> [right|double] | desk type <نص> | desk key <Enter|Tab|Esc|ctrl+s|alt+f4|win|…> | desk scroll <up|down> [عدد] — والإحداثيّاتُ من زاوية النافذة المركَّزة العليا اليسرى"
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
    case "focus": return arg.length === 0 ? { error: DESKTOP_USAGE } : { kind: "focus", title: arg.slice(0, 120) }
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
    default: return { error: DESKTOP_USAGE }
  }
}

const vkOf = (name: string): number => (name in KEY_VK ? KEY_VK[name]! : name.toUpperCase().charCodeAt(0))
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64")

/** رأسُ Win32 المشترك — يُعرَّف مرّةً لكلّ سكربت (كلُّ نداءٍ عمليّةُ PowerShell مستقلّة). */
export const WIN32_PRELUDE = `$ErrorActionPreference = 'Stop'
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
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 4 }
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
const foregroundGuard = (hwnd: number): string => `$want = [IntPtr]${hwnd}
$fg = [AbdoDesk]::GetForegroundWindow()
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
export function desktopScript(action: DesktopAction, shotPath = "", bound?: DesktopBound): string {
  switch (action.kind) {
    case "shot": {
      const path = shotPath.replace(/'/g, "''")
      // اللقطةُ الافتراضيّة **للنافذة المربوطة وحدها**: سطحُ مكتب المستخدم كلُّه لا يُصوَّر لأنّ الوكيل يريد زرّاً.
      if (bound !== undefined && action.scope !== "screen") {
        return `${WIN32_PRELUDE}Add-Type -AssemblyName System.Drawing
$want = [IntPtr]${bound.hwnd}
$fg = [AbdoDesk]::GetForegroundWindow()
if (([int64]$fg) -ne ${bound.hwnd}) { Out-Json @{ ok = $false; error = 'window is not in front'; foreground = [AbdoDesk]::Title($fg) }; exit 0 }
$r = New-Object AbdoDesk+RECT
if (-not [AbdoDesk]::GetWindowRect($want, [ref]$r)) { Out-Json @{ ok = $false; error = 'window gone' }; exit 0 }
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
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
    case "focus": return `${WIN32_PRELUDE}${WINDOWS_LIST}$needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.title)}')).ToLowerInvariant()
$hit = $list | Where-Object { $_.title.ToLowerInvariant().Contains($needle) } | Select-Object -First 1
if ($null -eq $hit) { Out-Json @{ ok = $false; error = 'no window matches'; count = $list.Count }; exit 0 }
$raised = [AbdoDesk]::Focus([IntPtr]$hit.hwnd); Start-Sleep -Milliseconds 150
$fg = [AbdoDesk]::GetForegroundWindow()
if (([int64]$fg) -ne ([int64]$hit.hwnd)) { Out-Json @{ ok = $false; error = 'could not bring the window to the front'; raised = $raised; foreground = [AbdoDesk]::Title($fg) }; exit 0 }
$r = New-Object AbdoDesk+RECT; [void][AbdoDesk]::GetWindowRect([IntPtr]$hit.hwnd, [ref]$r)
Out-Json @{ ok = $true; hwnd = $hit.hwnd; title = $hit.title; pid = $hit.pid; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
`
    case "click": {
      const down = action.button === "right" ? "0x0008" : "0x0002", up = action.button === "right" ? "0x0010" : "0x0004"
      const times = action.button === "double" ? 2 : 1
      return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd)}$sx = $r.Left + ${action.x}; $sy = $r.Top + ${action.y}
if (${action.x} -ge ($r.Right - $r.Left) -or ${action.y} -ge ($r.Bottom - $r.Top)) { Out-Json @{ ok = $false; error = 'point is outside the window now'; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }; exit 0 }
[void][AbdoDesk]::SetCursorPos($sx, $sy); Start-Sleep -Milliseconds 40
$p = New-Object AbdoDesk+POINT
if (-not [AbdoDesk]::GetCursorPos([ref]$p)) { Out-Json @{ ok = $false; error = 'cursor position unreadable' }; exit 0 }
if ($p.X -ne $sx -or $p.Y -ne $sy) { Out-Json @{ ok = $false; error = 'the cursor did not reach the point'; x = $p.X; y = $p.Y }; exit 0 }
${Array.from({ length: times }, () => `[AbdoDesk]::MouseButton(${down}); [AbdoDesk]::MouseButton(${up})`).join("; Start-Sleep -Milliseconds 60; ")}
${injectionTail(`; x = $sx; y = $sy; button = '${action.button}'`)}`
    }
    case "type": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd)}$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(action.text)}'))
foreach ($ch in $text.ToCharArray()) { if ($ch -eq "\`n") { [AbdoDesk]::KeyDown(13); [AbdoDesk]::KeyUp(13) } elseif ($ch -ne "\`r") { [AbdoDesk]::Unicode($ch) }; Start-Sleep -Milliseconds 8 }
${injectionTail("; chars = $text.Length")}`
    case "key": {
      const parts = action.combo.split("+")
      const vks = parts.map(vkOf)
      const mods = vks.filter((v) => MODIFIERS.has(v)), keys = vks.filter((v) => !MODIFIERS.has(v))
      return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd)}${mods.map((v) => `[AbdoDesk]::KeyDown(${v})`).join("; ")}${mods.length ? "; " : ""}${keys.map((v) => `[AbdoDesk]::KeyDown(${v}); [AbdoDesk]::KeyUp(${v})`).join("; ")}${mods.length ? "; " : ""}${[...mods].reverse().map((v) => `[AbdoDesk]::KeyUp(${v})`).join("; ")}
${injectionTail(`; combo = '${action.combo}'`)}`
    }
    case "scroll": return `${WIN32_PRELUDE}${foregroundGuard(bound!.hwnd)}for ($i = 0; $i -lt ${action.count}; $i++) { [AbdoDesk]::Wheel(${action.direction === "up" ? 120 : -120}); Start-Sleep -Milliseconds 30 }
${injectionTail(`; direction = '${action.direction}'; count = ${action.count}`)}`
  }
}

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

export interface DesktopResult { readonly text: string; readonly shot?: { readonly path: string; readonly scope: "window" | "screen" }; readonly windows?: readonly WindowInfo[]; readonly bound?: DesktopBound; readonly ok: boolean }

/**
 * المهلةُ من حجم العمل لا رقماً واحداً: `desk type` ينام ٨ms لكلّ حرف، فألفا حرفٍ تتجاوز العشرين ثانية —
 * كانت المهلةُ تقتل العمليّة **وسط الحقن** فيُروى فشلٌ والنصفُ الأوّل في المستند. (عيبٌ نجا من الدحض.)
 */
export const timeoutFor = (action: DesktopAction): number => {
  switch (action.kind) {
    case "type": return 20_000 + action.text.length * 30
    case "scroll": return 20_000 + action.count * 400
    case "shot": return 40_000
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

export async function runDesktop(action: DesktopAction, options: { shotsDir: string; runner?: DesktopRunner; bound?: DesktopBound; timeoutMs?: number; keepShots?: number }): Promise<DesktopResult> {
  const runner = options.runner ?? powershellRunner
  const bound = options.bound
  // **الغيابُ رفض**: بلا نافذةٍ مربوطة لا يُحقن إدخالٌ في «أيّ نافذةٍ في المقدّمة» — والحدُّ يُفحص قبل أن يُبنى السكربت.
  if (INPUT_KINDS.has(action.kind) && bound === undefined) return { ok: false, text: NEEDS_FOCUS }
  if (action.kind === "click" && !withinWindow(action.x, action.y, bound!)) return { ok: false, text: `رُفضت النقرة (${action.x},${action.y}): خارج نافذة «${bound!.title.slice(0, 60)}» (${bound!.right - bound!.left}×${bound!.bottom - bound!.top}) — الإحداثيّاتُ من زاويتها العليا اليسرى` }
  let shotPath = ""
  if (action.kind === "shot") {
    mkdirSync(options.shotsDir, { recursive: true })
    pruneShots(options.shotsDir, Math.max(0, (options.keepShots ?? 20) - 1))
    shotPath = join(options.shotsDir, `desk-${Date.now()}.png`)
  }
  const out = await runner.run(desktopScript(action, shotPath, bound), options.timeoutMs ?? timeoutFor(action))
  const json = lastJson(out.stdout)
  // انقطاعٌ بالمهلة وسط حقنٍ ليس فشلاً نظيفاً: بعضُ الإدخال قد يكون وصل، فيُقال ذلك بدل «فشل» يغري بإعادةٍ تُكرّره.
  if (out.timedOut === true && INPUT_KINDS.has(action.kind)) return { ok: false, text: `انقطع ${action.kind} بعد المهلة: **قد يكون جزءٌ من الإدخال وصل** نافذة «${bound!.title.slice(0, 60)}» — تحقّق من حالتها قبل الإعادة (لا تُعِد الأمر كما هو).` }
  if (json === undefined || json.ok !== true) {
    const reason = typeof json?.error === "string" && json.error.length > 0 ? json.error : (out.stderr.trim().split("\n")[0] ?? "").trim() || `exit ${out.code}`
    const foreground = typeof json?.foreground === "string" && json.foreground.length > 0 ? ` (المقدّمةُ الآن: «${json.foreground.slice(0, 60)}»)` : ""
    // حُجب الحقنُ أو تحرّكت المقدّمةُ أثناءه: يُقال بلا تجميل — فالإدخالُ الذي لم يصل لا يُروى نجاحاً.
    if (json?.blocked === true) return { ok: false, text: `رُفض ${action.kind}: حجب النظامُ الإدخال (${json.accepted}/${json.asked}) — النافذةُ الأمامية غالباً مرفوعةُ الصلاحيّة، وعبدو لا يرفع صلاحيّته${foreground}.` }
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
      return { ok: true, windows, text: windows.length === 0 ? "لا نوافذَ ظاهرة." : `${windows.length} نافذة:\n${windows.slice(0, 40).map((w) => `- «${w.title.slice(0, 80)}» [${w.right - w.left}×${w.bottom - w.top}] pid ${w.pid}`).join("\n")}` }
    }
    case "focus": {
      const next: DesktopBound = { hwnd: Number(json.hwnd), title: String(json.title ?? ""), left: Number(json.left), top: Number(json.top), right: Number(json.right), bottom: Number(json.bottom) }
      return { ok: true, bound: next, text: `ركّزتُ نافذة «${next.title.slice(0, 80)}» (${next.right - next.left}×${next.bottom - next.top}) — الإدخالُ يذهب إليها وحدها، والإحداثيّاتُ من زاويتها العليا اليسرى.` }
    }
    case "click": return { ok: true, text: `نقرتُ ${action.button} على (${action.x},${action.y}) داخل «${String(json.foreground ?? "").slice(0, 60)}».` }
    case "type": return { ok: true, text: `كتبتُ ${json.chars} حرفاً في «${String(json.foreground ?? "").slice(0, 80)}».` }
    case "key": return { ok: true, text: `ضغطتُ ${action.combo} في «${String(json.foreground ?? "").slice(0, 80)}».` }
    case "scroll": return { ok: true, text: `مرّرتُ ${action.direction} ×${action.count} في «${String(json.foreground ?? "").slice(0, 60)}».` }
  }
}
