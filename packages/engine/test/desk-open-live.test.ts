import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDesktop } from "../src/desktop-control"

// م6و — `desk open` حيّاً: يُقلع الرسّام (mspaint) بـShellExecute، ينتظر نافذتَه الجديدة، يربطها ويعيد pid نافذتها؛
// ثمّ `desk windows` بمجموعة النوافذ السابقة يسمّي نافذةَ الرسّام «جديدة». التنظيف بقتل عمليّة النافذة المربوطة (لا الإقلاع: تطبيقاتُ المتجر تُسلِّم).
const ps = async (cmd: string): Promise<string> => { const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return o.trim() }

test.skipIf(process.platform !== "win32")("desk open launches an app, binds its new window, and windows marks it as new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-open-"))
  let boundPid = 0
  try {
    const before = await runDesktop({ kind: "windows" }, { shotsDir: dir })
    expect(before.ok).toBe(true)
    const known = before.windows!.map((w) => w.hwnd)
    const opened = await runDesktop({ kind: "open", app: "mspaint" }, { shotsDir: dir })
    expect(opened.ok, opened.text).toBe(true)
    expect(opened.bound).toBeDefined()
    expect(opened.bound!.right - opened.bound!.left).toBeGreaterThan(100)
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
