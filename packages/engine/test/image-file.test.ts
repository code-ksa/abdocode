/**
 * أداةُ الصورة — الصورةُ على القرص تُصغَّر حتى تتّسع في سقف البوّابة (مقيس: PNG 1280×720 من بليندر ≈ ٨٧٠ كيلوبايت ⇦ base64 فوق ٣٥٠ ألفاً).
 * التوأمان: صورةٌ كبيرة ⇦ تتّسع بدرجةٍ من السلّم وتُقال الأبعاد؛ غيرُ صورةٍ/غيرُ موجود ⇦ رفضٌ بالاسم؛ سقفٌ مستحيل ⇦ رفضٌ يسمّي السلّم.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_IMAGE_BASE64 } from "@abdo/model-gateway"
import { imageFileVerdict, imageReceiptLine, prepareImageFile } from "../src/image-file"

const makePng = (path: string, w: number, h: number): void => {
  // صورةُ اختبار ملوّنة بلا اعتماد: PowerShell System.Drawing (ويندوز هو المنتَج)
  const script = `Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap ${w},${h}; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::SkyBlue); $g.FillRectangle([System.Drawing.Brushes]::Red,50,50,${Math.floor(w / 2)},${Math.floor(h / 2)}); $r=New-Object System.Random; for($i=0;$i -lt 4000;$i++){ $b.SetPixel($r.Next(${w}),$r.Next(${h}),[System.Drawing.Color]::FromArgb($r.Next(256),$r.Next(256),$r.Next(256))) }; $g.Dispose(); $b.Save('${path.replace(/'/gu, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`
  const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

describe("image file → vision-ready JPEG", () => {
  test.skipIf(process.platform !== "win32")("a 1600×900 PNG is scaled through the ladder until it fits the gateway cap, with dimensions named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-image-"))
    try {
      const png = join(dir, "render.png"); makePng(png, 1600, 900)
      const prepared = await prepareImageFile(png, MAX_IMAGE_BASE64)
      expect(prepared.ok).toBe(true)
      if (prepared.ok) {
        expect(prepared.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64)
        expect(prepared.source).toBe("1600x900")
        expect(prepared.scaled).toMatch(/^\d+x\d+$/u)
        expect(prepared.mime).toBe("image/jpeg")
        expect(imageReceiptLine("render.png", prepared, true, "vision")).toContain("تصل نموذجَ الرؤية")
        expect(imageReceiptLine("render.png", prepared, false, undefined)).toContain("لا نموذجَ رؤيةٍ")
      }
      // سقفٌ مستحيل ⇦ رفضٌ يسمّي السلّم (لا صورةَ تُرسَل فوق السقف)
      const tooSmall = await prepareImageFile(png, 1_000)
      expect(tooSmall.ok).toBe(false)
      if (!tooSmall.ok) expect(tooSmall.why).toContain("لا تتّسع")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
  test("non-images and missing files are refused by name (negative twin)", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-image-neg-"))
    try {
      writeFileSync(join(dir, "notes.txt"), "x")
      expect(imageFileVerdict(join(dir, "notes.txt"))).toContain("ليس ملفَّ صورة")
      expect(imageFileVerdict(join(dir, "missing.png"))).toBe("الملفّ غير موجود")
      writeFileSync(join(dir, "empty.png"), "")
      expect(imageFileVerdict(join(dir, "empty.png"))).toBe("الملفّ فارغ")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
