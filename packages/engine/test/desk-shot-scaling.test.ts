/**
 * 10-09 — desktop screenshots were full-size PNGs: over the model's image cap, `desk point` refused and `desk shot` silently sent no
 * image. They now go through the image ladder; the vision model answers in the scaled image and the point maps back to the window.
 * Measured here on a real full-screen capture of this machine (Windows only), not on a synthetic file.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_IMAGE_BASE64 } from "@abdo/model-gateway"
import { prepareImageFile } from "../src/image-file"
import { parseDims, scaledShotLine, scalePoint } from "../src/look-and-point"

describe("scaled screenshots map points back to the window", () => {
  test("a point in a 1280×720 image of a 1920×1080 window lands on the same spot in window pixels, clamped inside", () => {
    const seen = { width: 1280, height: 720 }, win = { width: 1920, height: 1080 }
    expect(scalePoint(0, 0, seen, win)).toEqual({ x: 0, y: 0 })
    expect(scalePoint(640, 360, seen, win)).toEqual({ x: 960, y: 540 })
    expect(scalePoint(1279, 719, seen, win)).toEqual({ x: 1919, y: 1079 })
    // the twin: an unscaled shot is the identity
    expect(scalePoint(417, 233, win, win)).toEqual({ x: 417, y: 233 })
  })
  test("dims parse strictly, and the receipt names the scale only when there was one", () => {
    expect(parseDims("1920x1080")).toEqual({ width: 1920, height: 1080 })
    expect(parseDims("1920 x 1080")).toBeUndefined()
    expect(scaledShotLine("1920x1080", "1280x720")).toContain("1920x1080 ⇦ 1280x720")
    expect(scaledShotLine("800x600", "800x600")).toBe("")
  })
  test.skipIf(process.platform !== "win32")("a real full-screen capture fits the model's image cap after the ladder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-deskshot-"))
    try {
      const file = join(dir, "screen.png")
      const script = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $g.Dispose(); $bmp.Save('${file.replace(/'/gu, "''")}',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()`
      const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])
      expect(proc.exitCode).toBe(0)
      const prepared = await prepareImageFile(file, MAX_IMAGE_BASE64)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      expect(prepared.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64)
      expect(parseDims(prepared.scaled)!.width).toBeLessThanOrEqual(1280)
      console.log(`raw png ${statSync(file).size} bytes (${Math.round(statSync(file).size * 4 / 3)} base64 chars) ⇒ ${prepared.source} ⇦ ${prepared.scaled}, ${prepared.data.length} chars`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
