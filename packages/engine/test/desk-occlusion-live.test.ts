/**
 * 10-11 — النقرةُ داخل مستطيل النافذة المربوطة قد تقع على نافذةِ تطبيقٍ آخر يغطّيها (نافذةٌ دائمةُ العلوّ، إشعار) فتُنفَّذ هناك.
 * مقيسٌ على نافذتين حقيقيّتين في عمليّتين: الهدفُ بزرّ، وغطاءٌ دائمُ العلوّ فوق الزرّ. النقرُ على الزرّ يُرفض باسم الغطاء ولا يصل الزرَّ؛
 * والتوأمُ: نقرةٌ على موضعٍ مكشوف تصل وتقول ما أصابت. الحقيقةُ من ملفّ الهدف لا من إيصال الأداة.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDesktop, type DesktopBound } from "../src/desktop-control"
import { ORANGE_FORM } from "./helpers/orange-window"

const TARGET = [
  "param([string]$Out)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  ...ORANGE_FORM,
  "$f.Text = 'AbdoOcclTarget'; $f.Width = 600; $f.Height = 400; $f.StartPosition = 'Manual'; $f.Left = 200; $f.Top = 200",
  "$b = New-Object System.Windows.Forms.Button; $b.Text = 'Covered button'; $b.Left = 40; $b.Top = 40; $b.Width = 200; $b.Height = 60",
  "$c = New-Object System.Windows.Forms.Button; $c.Text = 'Open button'; $c.Left = 340; $c.Top = 240; $c.Width = 200; $c.Height = 60",
  "$script:hits = ''",
  "$b.Add_Click({ $script:hits += 'covered;' }); $c.Add_Click({ $script:hits += 'open;' })",
  "$f.Controls.Add($b); $f.Controls.Add($c)",
  "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 150; $t.Add_Tick({ try { [IO.File]::WriteAllText($Out, 'hits=' + $script:hits) } catch { } }); $t.Start()",
  "[void]$f.ShowDialog()",
].join("\r\n")
const COVER = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  ...ORANGE_FORM,
  "$f.Text = 'AbdoOcclCover'; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.FormBorderStyle = 'FixedToolWindow'",
  "$f.StartPosition = 'Manual'; $f.Left = 200; $f.Top = 200; $f.Width = 330; $f.Height = 200",
  "[void]$f.ShowDialog()",
].join("\r\n")

test.skipIf(process.platform !== "win32" || process.env.ABDO_DESK_LIVE !== "1")("a click on a point another app's window covers is refused by its name and never lands; an uncovered point lands and says what it hit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-occl-"))
  const target = join(dir, "target.ps1"), cover = join(dir, "cover.ps1"), out = join(dir, "truth.txt"), shots = join(dir, "shots")
  writeFileSync(target, TARGET); writeFileSync(cover, COVER)
  const truth = () => (existsSync(out) ? readFileSync(out, "utf8") : "")
  const a = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", target, "-Out", out], { stdout: "ignore", stderr: "ignore" })
  for (const deadline = Date.now() + 20_000; truth().length === 0 && Date.now() < deadline;) await Bun.sleep(100)
  const b = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", cover], { stdout: "ignore", stderr: "ignore" })
  try {
    await Bun.sleep(1500)
    let f = await runDesktop({ kind: "focus", title: "AbdoOcclTarget" }, { shotsDir: shots })
    for (let n = 0; n < 2 && !f.ok; n += 1) { await Bun.sleep(700); f = await runDesktop({ kind: "focus", title: "AbdoOcclTarget" }, { shotsDir: shots }) }
    expect(f.ok, f.text).toBe(true)
    const bound: DesktopBound = f.bound!
    const scale = (bound.right - bound.left) / 600
    // the covered button: the cover window (another process, top-most) sits over it
    const covered = await runDesktop({ kind: "click", x: Math.round(140 * scale), y: Math.round(100 * scale), button: "left" }, { shotsDir: shots, bound })
    expect(covered.ok, covered.text).toBe(false)
    expect(covered.text).toContain("AbdoOcclCover")
    await Bun.sleep(400)
    expect(truth()).not.toContain("covered;")
    // the twin: the open button is not covered — the click lands and names what it hit
    let refocus = await runDesktop({ kind: "focus", title: "AbdoOcclTarget" }, { shotsDir: shots })
    for (let n = 0; n < 2 && !refocus.ok; n += 1) { await Bun.sleep(700); refocus = await runDesktop({ kind: "focus", title: "AbdoOcclTarget" }, { shotsDir: shots }) }
    const open = await runDesktop({ kind: "click", x: Math.round(440 * scale), y: Math.round(300 * scale), button: "left" }, { shotsDir: shots, bound: refocus.bound ?? bound })
    expect(open.ok, open.text).toBe(true)
    expect(open.text).toContain("Open button")
    await Bun.sleep(400)
    expect(truth()).toContain("open;")
  } finally {
    for (const p of [a, b]) { try { p.kill() } catch { /* exited */ } }
  }
}, 120_000)
