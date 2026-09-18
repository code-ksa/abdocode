import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findLayout, layoutFromMeasure, layoutMatches, loadLayouts, saveLayouts, upsertLayout, LAYOUTS_FILE } from "../src/desk-layouts"
import { powershellRunner, runDesktop, type DesktopBound } from "../src/desktop-control"

// S8 (09-18) — **اللوحُ الحيّ على نافذةٍ نملكها**: الاستعادةُ تُقاس بأثرها — النافذةُ تُنقل فعلاً بـSetWindowPos ويُقرأ مستطيلُها
// من النظام بعد النقل، والمسبارُ يعيد العمليّةَ والمقياسَ ومنطقةَ العميل، واللقطةُ تسمّي وضعَها وإطارَها ومقياسَها.
// لا حقنَ إدخالٍ هنا: تركيزٌ وقياسٌ ونقلٌ وتكبيرٌ ولقطةٌ لنافذةٍ أنشأها الاختبارُ نفسُه.

const FIXTURE = [
  "param([string]$Title)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.Text = $Title",
  "$f.Width = 620",
  "$f.Height = 340",
  "$f.StartPosition = 'Manual'",
  "$f.Left = 60",
  "$f.Top = 90",
  "$f.Add_Shown({ [void]$f.Activate() })",
  "[System.Windows.Forms.Application]::Run($f)",
  "",
].join("\r\n")

const PS = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const until = async (label: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await ok())) { if (Date.now() > deadline) throw Error(`timed out: ${label}`); await Bun.sleep(200) }
}

test.skipIf(process.platform !== "win32")("desk measures the bound window (process, scale, client), places it where a saved layout says, maximizes on request, and the shot names its frame", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-desk-layout-live-"))
  const script = join(dir, "window.ps1")
  writeFileSync(script, FIXTURE)
  const title = `abdo-desk-layout-${process.pid}-${Math.floor(Date.now() / 1000) % 100_000}`
  const child = Bun.spawn([PS, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, title], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const desk = (action: Parameters<typeof runDesktop>[0], bound?: DesktopBound) => runDesktop(action, { shotsDir: join(dir, "shots"), runner: powershellRunner, ...(bound === undefined ? {} : { bound }) })
  try {
    await until("window visible", async () => ((await desk({ kind: "windows" })).windows ?? []).some((w) => w.title === title))
    const focus = await desk({ kind: "focus", title })
    expect(focus.ok).toBe(true)
    const bound = focus.bound!
    // المسبارُ مع التركيز: العمليّةُ powershell، المقياسُ موجب، منطقةُ العميل أصغرُ من النافذة (إطارٌ وشريطُ عنوان)
    expect(focus.measure?.process.toLowerCase()).toBe("powershell")
    expect(focus.measure?.maximized).toBe(false)
    expect(focus.frame?.scale).toBeGreaterThan(0)
    expect(focus.frame?.mode).toBe("windowed")
    expect(focus.frame!.client.width).toBeLessThan(focus.frame!.window.width)
    expect(focus.frame!.client.y).toBeGreaterThan(0)
    // rect يقيس الشيءَ نفسَه
    const rect = await desk({ kind: "rect" }, bound)
    expect(rect.ok).toBe(true)
    expect(rect.measure).toEqual(focus.measure)
    expect(rect.text).toContain("العمليّة powershell")
    // لاياوتٌ محفوظ في ملفٍّ مؤقّت يقول «300,200 بحجم 500×300» ⇦ place ثمّ قياسٌ بعده يطابق
    const file = join(dir, LAYOUTS_FILE)
    saveLayouts(file, upsertLayout(loadLayouts(file), layoutFromMeasure({ process: rect.measure!.process, title, rect: { left: 300, top: 200, right: 800, bottom: 500 }, monitor: rect.measure!.monitor })))
    const saved = findLayout(loadLayouts(file), rect.measure!.process, title)!
    expect(saved).toBeDefined()
    expect(layoutMatches(saved, rect.measure!)).toBe(false)
    const placed = await desk({ kind: "place", x: saved.x, y: saved.y, width: saved.width, height: saved.height, state: saved.state }, bound)
    expect(placed.ok).toBe(true)
    expect(layoutMatches(saved, placed.measure!)).toBe(true)
    expect(placed.bound).toEqual({ ...bound, left: placed.measure!.left, top: placed.measure!.top, right: placed.measure!.right, bottom: placed.measure!.bottom })
    const again = await desk({ kind: "rect" }, placed.bound)
    expect(layoutMatches(saved, again.measure!)).toBe(true)
    // اللقطةُ بعد النقل تسمّي إطارَها الجديد ومقياسَها
    const shot = await desk({ kind: "shot", scope: "auto" }, placed.bound!)
    expect(shot.ok).toBe(true)
    expect(shot.text).toContain(`الوضع: نافذة، الإطار ${saved.width}×${saved.height} @ (${saved.x},${saved.y})`)
    expect(shot.text).toMatch(/المقياس \d+(?:\.\d+)?\./u)
    expect(shot.frame?.window).toEqual({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
    // التكبيرُ بالحالة: place بحالة maximized ⇦ IsZoomed، ثمّ العودةُ إلى المستطيل تُلغي التكبير
    const max = await desk({ kind: "place", x: saved.x, y: saved.y, width: saved.width, height: saved.height, state: "maximized" }, placed.bound)
    expect(max.ok).toBe(true)
    expect(max.measure?.maximized).toBe(true)
    const back = await desk({ kind: "place", x: saved.x, y: saved.y, width: saved.width, height: saved.height, state: "normal" }, max.bound)
    expect(back.measure?.maximized).toBe(false)
    expect(layoutMatches(saved, back.measure!)).toBe(true)
    // الحفظُ لم يُلمس بكلّ ذلك
    expect(loadLayouts(file).layouts).toEqual([saved])
  } finally {
    try { child.kill() } catch { /* انتهى */ }
    await child.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)
