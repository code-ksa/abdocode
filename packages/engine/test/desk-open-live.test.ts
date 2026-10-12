import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDesktop } from "../src/desktop-control"
import { ORANGE_FORM } from "./helpers/orange-window"

// م6و — `desk open` حيّاً: يُقلع تطبيقاً بـShellExecute، ينتظر نافذتَه الجديدة، يربطها ويعيد pid نافذتها؛
// 10-12 — «التطبيقُ» نافذتُنا البرتقاليّة الخفيفة يُقلعها مُشغّلُ .vbs (بلا طرفيّة تومض).
// ثمّ `desk windows` بمجموعة النوافذ السابقة يسمّي النافذةَ «جديدة». التنظيف بقتل عمليّة النافذة المربوطة (لا الإقلاع: تطبيقاتُ المتجر تُسلِّم).
const ps = async (cmd: string): Promise<string> => { const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return o.trim() }

test.skipIf(process.platform !== "win32" || process.env.ABDO_DESK_LIVE !== "1")("desk open launches an app, binds its new window, and windows marks it as new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-open-"))
  let boundPid = 0
  try {
    const before = await runDesktop({ kind: "windows" }, { shotsDir: dir })
    expect(before.ok).toBe(true)
    const known = before.windows!.map((w) => w.hwnd)
    const form = join(dir, "orange-app.ps1"), launcher = join(dir, "orange-app.vbs")
    writeFileSync(form, ["Add-Type -AssemblyName System.Windows.Forms", "$f = New-Object System.Windows.Forms.Form", ...ORANGE_FORM, "$f.Text = 'AbdoCode orange app'", "$f.Width = 520; $f.Height = 320; $f.StartPosition = 'CenterScreen'", "[void]$f.ShowDialog()"].join("\r\n"))
    writeFileSync(launcher, `CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${form}""", 0, False\r\n`)
    const opened = await runDesktop({ kind: "open", app: launcher }, { shotsDir: dir })
    expect(opened.ok, opened.text).toBe(true)
    expect(opened.bound).toBeDefined()
    expect(opened.bound!.right - opened.bound!.left).toBeGreaterThan(100)
    expect(opened.bound!.title).toBe("AbdoCode orange app")
    const m = opened.text.match(/pid (\d+)/)
    boundPid = Number(m?.[1] ?? 0)
    expect(boundPid).toBeGreaterThan(0)
    const after = await runDesktop({ kind: "windows" }, { shotsDir: dir, knownHwnds: known })
    const line = after.text.split("\n").find((l) => l.includes(`pid ${boundPid}`) && l.includes("(جديدة)"))
    expect(line, after.text).toBeDefined()
  } finally {
    if (boundPid > 0) await ps(`Stop-Process -Id ${boundPid} -Force -ErrorAction SilentlyContinue`)
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
