import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDesktop, type DesktopBound, type UiContext } from "../src/desktop-control"

// م6/م6ب — **اللوحُ الحيّ على نافذةٍ نملكها** (WinForms، خلفيّةٌ أرجوانيّة، مؤقّتٌ يكتب الحقيقةَ إلى ملفّ كلَّ ١٥٠ms):
//   (أ) اللقطةُ صادقة على شاشةٍ مُكبَّرة: بكسلٌ داخل النافذة أرجوانيّ (قبل الوعي بالـDPI كانت الصورةُ منطقةً أخرى — مقيس على 150٪).
//   (ب) النقرُ يصيب الزرَّ (clicks=1 في ملفّ النافذة) والكتابةُ تصل المربّع بالعربيّة.
//   (ج) `ui` يرى الزرَّ Button والمربّعَ Edit (لا Pane) بأسمائهما؛ `set` يستبدل النصَّ والقراءةُ الراجعة مطابقة؛ `press` يزيد العدّاد.
//   (د) التوأمُ السلبيّ: مرجعٌ مجهول يُرفض بلا سكربت.
// الحقيقةُ من ملفّ النافذة لا من إيصال الأداة.

const FIXTURE = [
  "param([string]$Out)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.Text = 'AbdoUiaLive'",
  "$f.Width = 600; $f.Height = 420; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true",
  "$f.BackColor = [System.Drawing.Color]::Magenta",
  "$b = New-Object System.Windows.Forms.Button",
  "$b.Text = 'Probe button'; $b.Left = 50; $b.Top = 50; $b.Width = 200; $b.Height = 60",
  "$t = New-Object System.Windows.Forms.TextBox",
  "$t.Multiline = $true; $t.Left = 50; $t.Top = 130; $t.Width = 480; $t.Height = 200; $t.AccessibleName = 'Notes'",
  "$script:clicks = 0",
  "$b.Add_Click({ $script:clicks++; $t.AppendText(\"CLICKED#$($script:clicks)\") })",
  "$f.Controls.Add($b); $f.Controls.Add($t)",
  "$timer = New-Object System.Windows.Forms.Timer",
  "$timer.Interval = 150",
  "$timer.Add_Tick({ try { [IO.File]::WriteAllText($Out, \"clicks=$($script:clicks)|text=\" + $t.Text) } catch { } })",
  "$timer.Start()",
  "[void]$f.ShowDialog()",
].join("\r\n")

const ps = async (cmd: string): Promise<string> => { const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return o.trim() }

test.skipIf(process.platform !== "win32")("desk on a real window: DPI-true screenshot, click and type land, ui/set/press by reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-uia-"))
  const script = join(dir, "probe.ps1"), out = join(dir, "truth.txt"), shots = join(dir, "shots")
  writeFileSync(script, FIXTURE)
  const form = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Out", out], { stdout: "ignore", stderr: "pipe" })
  const truth = () => (existsSync(out) ? readFileSync(out, "utf8") : "")
  try {
    await Bun.sleep(2500)
    const f = await runDesktop({ kind: "focus", title: "AbdoUiaLive" }, { shotsDir: shots })
    expect(f.ok, f.text).toBe(true)
    const bound = f.bound as DesktopBound
    const scale = (bound.right - bound.left) / 600 // ١ على شاشة 100٪، ١٫٥ على 150٪ — البكسلاتُ فعليّة بعد الوعي بالـDPI
    expect(scale).toBeGreaterThanOrEqual(1)

    // (أ) اللقطةُ صادقة: بكسلُ خلفيّةٍ داخل النافذة أرجوانيّ
    const s = await runDesktop({ kind: "shot", scope: "auto" }, { shotsDir: shots, bound })
    expect(s.ok, s.text).toBe(true)
    const px = await ps(`Add-Type -AssemblyName System.Drawing; $b = [System.Drawing.Bitmap]::FromFile('${s.shot!.path}'); $p = $b.GetPixel(${Math.round(20 * scale)}, ${Math.round(300 * scale)}); "$($b.Width)x$($b.Height) $($p.R),$($p.G),$($p.B)"; $b.Dispose()`)
    expect(px).toBe(`${bound.right - bound.left}x${bound.bottom - bound.top} 255,0,255`)

    // (ب) النقرُ يصيب الزرَّ والكتابةُ تصل المربّع
    const c = await runDesktop({ kind: "click", x: Math.round(158 * scale), y: Math.round(111 * scale), button: "left" }, { shotsDir: shots, bound })
    expect(c.ok, c.text).toBe(true)
    await Bun.sleep(350)
    expect(truth()).toContain("clicks=1")
    await runDesktop({ kind: "click", x: Math.round(200 * scale), y: Math.round(200 * scale), button: "left" }, { shotsDir: shots, bound })
    const ty = await runDesktop({ kind: "type", text: "live عربي" }, { shotsDir: shots, bound })
    expect(ty.ok, ty.text).toBe(true)
    await Bun.sleep(350)
    expect(truth()).toContain("live عربي")

    // (ج) الشجرةُ بالأنواع الصحيحة، ثمّ set/press بالمرجع
    const ui = await runDesktop({ kind: "ui", depth: 8 }, { shotsDir: shots, bound })
    expect(ui.ok, ui.text).toBe(true)
    const button = ui.elements!.find((e) => e.type === "Button" && e.name === "Probe button")
    const notes = ui.elements!.find((e) => e.type === "Edit")
    expect(button, ui.text).toBeDefined()
    expect(notes, ui.text).toBeDefined()
    const ctx: UiContext = { depth: 8, elements: ui.elements! }
    const st = await runDesktop({ kind: "set", ref: notes!.ref, text: "set by ref" }, { shotsDir: shots, bound, ui: ctx })
    expect(st.ok, st.text).toBe(true)
    expect(st.text).toContain("مطابقة")
    const pr = await runDesktop({ kind: "press", ref: button!.ref }, { shotsDir: shots, bound, ui: ctx })
    expect(pr.ok, pr.text).toBe(true)
    await Bun.sleep(400)
    const final = truth()
    expect(final).toContain("clicks=2")
    expect(final).toContain("text=set by refCLICKED#2") // set استبدل ولم يُلحق، ثمّ press أضاف

    // (د) التوأمُ السلبيّ
    const stale = await runDesktop({ kind: "press", ref: 999 }, { shotsDir: shots, bound, ui: ctx })
    expect(stale.ok).toBe(false)
    expect(stale.text).toContain("u999")
  } finally {
    try { form.kill() } catch { /* أُغلقت */ }
    await Bun.sleep(200)
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)
