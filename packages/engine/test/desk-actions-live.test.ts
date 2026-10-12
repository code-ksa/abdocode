/**
 * 10-09 — the desk actions a strong computer-use agent relies on: triple and middle click, moving the cursor without clicking, scrolling
 * at a point, and zooming into a region at full resolution. Measured by effect on a real window we own: a WinForms surface appends every
 * mouse event it actually receives to a file, so the test reads what arrived, not the script that was generated.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDesktopCommand, powershellRunner, runDesktop, type DesktopBound } from "../src/desktop-control"
import { ORANGE_FORM } from "./helpers/orange-window"

const FIXTURE = [
  "param([string]$Out, [string]$Title)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$f = New-Object System.Windows.Forms.Form",
  ...ORANGE_FORM,
  "$f.Text = $Title",
  "$f.Width = 640",
  "$f.Height = 420",
  "$f.StartPosition = 'Manual'",
  "$f.Left = 120",
  "$f.Top = 120",
  "$log = { param($line) [IO.File]::AppendAllText($Out, $line + \"`n\") }",
  "$f.Add_MouseMove({ param($s, $e) & $log ('move ' + $e.X + ' ' + $e.Y) })",
  "$f.Add_MouseDown({ param($s, $e) & $log ('down ' + $e.Button + ' ' + $e.X + ' ' + $e.Y) })",
  "$f.Add_MouseWheel({ param($s, $e) & $log ('wheel ' + $e.Delta + ' ' + $e.X + ' ' + $e.Y) })",
  "$f.Add_Shown({ [void]$f.Activate() })",
  "[System.Windows.Forms.Application]::Run($f)",
  "",
].join("\r\n")

const PS = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const read = (path: string): string[] => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean) } catch { return [] } }
const until = async (label: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await ok())) { if (Date.now() > deadline) throw Error(`timed out: ${label}`); await Bun.sleep(150) }
}

test("the parser takes the new forms and refuses malformed ones by name", () => {
  expect(parseDesktopCommand("click 10 20 triple")).toEqual({ kind: "click", x: 10, y: 20, button: "triple" })
  expect(parseDesktopCommand("click 10 20 middle")).toEqual({ kind: "click", x: 10, y: 20, button: "middle" })
  expect(parseDesktopCommand("move 33 44")).toEqual({ kind: "move", x: 33, y: 44 })
  expect(parseDesktopCommand("scroll down 2 300 200")).toEqual({ kind: "scroll", direction: "down", count: 2, at: { x: 300, y: 200 } })
  expect(parseDesktopCommand("scroll down 2")).toEqual({ kind: "scroll", direction: "down", count: 2 })
  expect(parseDesktopCommand("zoom 10 20 120 80")).toEqual({ kind: "shot", scope: "auto", region: { x: 10, y: 20, w: 120, h: 80 } })
  expect("error" in parseDesktopCommand("zoom 10 20 4 80")).toBe(true)
  expect("error" in parseDesktopCommand("move -1 5")).toBe(true)
  expect("error" in parseDesktopCommand("scroll up 3 x 9")).toBe(true)
})

test.skipIf(process.platform !== "win32" || process.env.ABDO_DESK_LIVE !== "1")("triple and middle clicks, a hover, a scroll at a point and a zoomed region all land on the real window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-desk-actions-"))
  const script = join(dir, "surface.ps1"), out = join(dir, "events.txt")
  writeFileSync(script, FIXTURE)
  writeFileSync(out, "")
  const title = `abdo-desk-actions-${process.pid}`
  const proc = Bun.spawn([PS, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, out, title], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const desk = (action: Parameters<typeof runDesktop>[0], bound?: DesktopBound) => runDesktop(action, { shotsDir: join(dir, "shots"), runner: powershellRunner, ...(bound === undefined ? {} : { bound }) })
  try {
    await until("window visible", async () => ((await desk({ kind: "windows" })).windows ?? []).some((w) => w.title.includes(title)))
    let focus = await desk({ kind: "focus", title })
    for (let i = 0; i < 6 && !focus.ok; i += 1) { await Bun.sleep(400); focus = await desk({ kind: "focus", title }) }
    expect(`${focus.ok}: ${focus.text}`).toStartWith("true")
    const bound = focus.bound!
    const retry = async (action: Parameters<typeof runDesktop>[0]) => {
      let r = await desk(action, bound)
      for (let i = 0; i < 3 && !r.ok; i += 1) { await desk({ kind: "focus", title }); r = await desk(action, bound) }
      expect(`${r.ok}: ${r.text}`).toStartWith("true")
      return r
    }

    // hover: the window sees the cursor arrive, with no button pressed
    await retry({ kind: "move", x: 300, y: 200 })
    await until("a move reaches the window", () => read(out).some((l) => l.startsWith("move ")), 10_000)
    expect(read(out).some((l) => l.startsWith("down "))).toBe(false)
    const [hx, hy] = read(out).filter((l) => l.startsWith("move ")).at(-1)!.split(" ").slice(1).map(Number)

    // triple click at the same point: three left downs at the hovered client point
    await retry({ kind: "click", x: 300, y: 200, button: "triple" })
    await until("three left downs", () => read(out).filter((l) => l.startsWith("down Left ")).length >= 3, 10_000)
    expect(read(out).filter((l) => l.startsWith("down Left ")).every((l) => l === `down Left ${hx} ${hy}`)).toBe(true)

    // middle click: one Middle down, not Left
    await retry({ kind: "click", x: 320, y: 220, button: "middle" })
    await until("a middle down", () => read(out).some((l) => l.startsWith("down Middle ")), 10_000)

    // scroll at a point: the cursor moves there first, then the wheel turns (two notches down = negative deltas)
    await retry({ kind: "scroll", direction: "down", count: 2, at: { x: 200, y: 150 } })
    await until("two wheel notches", () => read(out).filter((l) => l.startsWith("wheel -")).length >= 2, 10_000)
    // the window reports logical (DPI-scaled) client pixels; desk speaks physical window pixels. Calibrate the scale from the middle
    // click, 20 physical pixels right of the hover, and expect the wheel at 100/50 physical pixels up-left of the hover.
    const [mx] = read(out).find((l) => l.startsWith("down Middle "))!.split(" ").slice(2).map(Number)
    const scale = (mx! - hx!) / 20
    const [wx, wy] = read(out).find((l) => l.startsWith("wheel -"))!.split(" ").slice(2).map(Number)
    expect(Math.abs(wx! - (hx! - 100 * scale))).toBeLessThanOrEqual(2)
    expect(Math.abs(wy! - (hy! - 50 * scale))).toBeLessThanOrEqual(2)

    // zoom: the region at full resolution, exactly the size asked for
    const zoom = await desk({ kind: "shot", scope: "auto", region: { x: 40, y: 60, w: 160, h: 90 } }, bound)
    expect(`${zoom.ok}: ${zoom.text}`).toStartWith("true")
    expect(zoom.text).toContain("(40,60)")
    const png = readFileSync(zoom.shot!.path)
    expect(`${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`).toBe("160×90")
  } finally {
    proc.kill(); await proc.exited
    for (let i = 0; i < 20; i += 1) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 180_000)
