/**
 * م11/الرؤية — أداةُ `image <ملف>`: صورةٌ محفوظة على القرص (رندرُ بليندر، لقطةٌ مصدَّرة) تُرفق بنموذج الرؤية في النداء التالي.
 * مقيس 2026-09-14: النموذجُ حاول `open file:///…png` فرُفض بالعقد (http/https فقط)، ثمّ `python -m http.server` فرُفض خادماً يدويّاً —
 * فلم يكن لعبدو كود سبيلٌ ليرى صورةً على القرص. التصغيرُ وJPEG بسلّم جودةٍ حتى يتّسع في سقف البوّابة (`MAX_IMAGE_BASE64`) — كما
 * تفعل `shot` — عبر System.Drawing في PowerShell (لا اعتمادَ جديداً؛ ويندوز هو المنتَج). الوحدةُ لا تقرّر التوجيه: `shotRoute` يبقى الحَكَم.
 */
import { existsSync, statSync } from "node:fs"
import { extname } from "node:path"

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"])
/** سلّمُ التصغير: عرضٌ أقصى ثمّ جودةُ JPEG — أوّلُ درجةٍ تتّسع في السقف تُؤخذ. */
export const IMAGE_LADDER: readonly { readonly width: number; readonly quality: number }[] = Object.freeze([
  { width: 1280, quality: 82 }, { width: 1024, quality: 70 }, { width: 800, quality: 55 }, { width: 640, quality: 45 }, { width: 480, quality: 40 },
])
export const IMAGE_MAX_SOURCE_BYTES = 40 * 1024 * 1024

export type PreparedImage = { readonly ok: true; readonly data: string; readonly mime: "image/jpeg"; readonly source: string; readonly scaled: string; readonly bytes: number; readonly step: number } | { readonly ok: false; readonly why: string }

/** سكربتُ PowerShell (ASCII فقط): يحمّل الصورة، يصغّرها إلى عرضٍ أقصى، ويكتب JPEG بجودةٍ base64 مع الأبعاد. */
const POWERSHELL_JPEG = (path: string, maxWidth: number, quality: number): string => [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  `$src=[System.Drawing.Image]::FromFile('${path.replace(/'/gu, "''")}')`,
  `$scale=[Math]::Min(1.0,${maxWidth}/$src.Width)`,
  "$w=[Math]::Max(1,[int]($src.Width*$scale)); $h=[Math]::Max(1,[int]($src.Height*$scale))",
  "$bmp=New-Object System.Drawing.Bitmap $w,$h",
  "$g=[System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode='HighQualityBicubic'; $g.Clear([System.Drawing.Color]::White); $g.DrawImage($src,0,0,$w,$h); $g.Dispose()",
  "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
  "$ep=New-Object System.Drawing.Imaging.EncoderParameters 1",
  `$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]${quality})`,
  "$ms=New-Object System.IO.MemoryStream; $bmp.Save($ms,$codec,$ep)",
  "[Console]::Out.Write(\"$($src.Width)x$($src.Height) ${w}x${h} \" + [Convert]::ToBase64String($ms.ToArray()))",
].join("; ")

const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64")

/** فحصٌ نقيّ قبل أيّ عمليّة: الامتدادُ والوجودُ والحجم. */
export function imageFileVerdict(absPath: string): string | undefined {
  const ext = extname(absPath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) return `ليس ملفَّ صورة (${ext || "بلا امتداد"}) — المقبول: ${[...IMAGE_EXTENSIONS].join(" ")}`
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return "الملفّ غير موجود"
  if (statSync(absPath).size > IMAGE_MAX_SOURCE_BYTES) return `الصورةُ أكبر من ${IMAGE_MAX_SOURCE_BYTES} بايت`
  if (statSync(absPath).size === 0) return "الملفّ فارغ"
  return undefined
}

/**
 * يجهّز الصورةَ لسقف البوّابة: يجرّب درجاتِ السلّم حتى يتّسع base64؛ يعيد الأبعادَ الأصليّة والمصغَّرة والدرجة. الفشلُ يُسمّى.
 */
export async function prepareImageFile(absPath: string, maxBase64: number, ladder = IMAGE_LADDER): Promise<PreparedImage> {
  const verdict = imageFileVerdict(absPath)
  if (verdict !== undefined) return { ok: false, why: verdict }
  let last = ""
  for (const [index, step] of ladder.entries()) {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(POWERSHELL_JPEG(absPath, step.width, step.quality))], { stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (code !== 0) return { ok: false, why: `تعذّر تحويل الصورة: ${err.replace(/\s+/gu, " ").trim().slice(0, 160) || `خرج ${code}`}` }
    const m = /^(\d+x\d+) (\d+x\d+) ([A-Za-z0-9+/=]+)$/u.exec(out.trim())
    if (m === null) return { ok: false, why: "تعذّر قراءة ناتج التحويل" }
    last = `${m[1]} ⇦ ${m[2]}`
    if (m[3]!.length <= maxBase64) return { ok: true, data: m[3]!, mime: "image/jpeg", source: m[1]!, scaled: m[2]!, bytes: Math.round(m[3]!.length * 3 / 4), step: index }
  }
  return { ok: false, why: `الصورةُ لا تتّسع في سقف البوّابة حتى بعد التصغير (${last})` }
}

/** سطرُ الإيصال للمشغّل والنموذج. */
export const imageReceiptLine = (target: string, prepared: Extract<PreparedImage, { ok: true }>, reaches: boolean, via: string | undefined): string =>
  reaches
    ? `أُرفقت الصورة ${target} (${prepared.source} ⇦ ${prepared.scaled}، ${prepared.bytes} بايت JPEG) — تصل ${via === "vision" ? "نموذجَ الرؤية" : "نموذجَ الحارة"} في النداء التالي؛ صِف ما تراه فيها بالأرقام لا بالظنّ.`
    : `الصورة ${target} (${prepared.source}) وصلت اللوحةَ فقط — لا نموذجَ رؤيةٍ يصلها الآن.`
