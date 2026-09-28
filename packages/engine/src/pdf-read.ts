/**
 * `read ملف.pdf` — نصُّ PDF للوكيل (برنامج «أكفأ من Codex» البند 7، 2026-09-28). كانت القراءةُ تمرّ بالنواة التي تعيد بايتاتٍ
 * فيرى النموذجُ ثنائيّاً لا يُقرأ. لا اعتمادَ جديد: `pdftotext` يأتي مع Git لويندوز (mingw64/bin — xpdf 4) ومع poppler-utils
 * على لينكس، والمحرّكُ يتطلّب git أصلاً. المقطعُ في `read ملف.pdf <من> [إلى]` **صفحاتٌ** لا أسطر.
 *
 * الحدود: المسارُ يُحسم داخل المشروع قبلنا (resolveProjectPath)، والأمرُ مصفوفةُ وسائط بلا صدفة، والخرجُ مسقوفٌ بإعلانٍ يقترح مقطعاً.
 * أداةٌ غائبة = رفضٌ يسمّي كيف تُثبَّت، لا ثنائيٌّ يُمرَّر.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export const PDF_TEXT_CAP = 40_000

type Spawn = (argv: readonly string[]) => { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }

const defaultSpawn: Spawn = (argv) => {
  const r = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

/** مكانُ pdftotext: متغيّرٌ صريح، ثمّ PATH، ثمّ بجانب git على ويندوز (mingw64/bin). */
export function pdftotextBinary(env: Readonly<Record<string, string | undefined>> = process.env, spawn: Spawn = defaultSpawn): string | undefined {
  const explicit = env["ABDO_PDFTOTEXT"]
  if (explicit !== undefined && explicit.length > 0) return existsSync(explicit) ? explicit : undefined
  const onPath = Bun.which("pdftotext")
  if (onPath !== null) return onPath
  if (process.platform !== "win32") return undefined
  try {
    const exec = spawn(["git", "--exec-path"]).stdout.trim()
    if (exec.length === 0) return undefined
    const beside = join(dirname(dirname(exec)), "bin", "pdftotext.exe")
    return existsSync(beside) ? beside : undefined
  } catch { return undefined }
}

export type PdfRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }

/** نصُّ الصفحات [from..to] (أو كلِّها) مع رأسٍ يقول ما قُرئ، ومسقوفاً. */
export function readPdf(file: string, range?: Readonly<{ from: number; to?: number }>, options: { readonly binary?: string; readonly spawn?: Spawn } = {}): PdfRead {
  // binary: "" = غائبٌ معلوم (للاختبار)؛ غيرُ ممرَّر = يُبحث عنه.
  const binary = options.binary !== undefined ? (options.binary.length > 0 ? options.binary : undefined) : pdftotextBinary()
  if (binary === undefined) return { ok: false, error: "قراءةُ PDF تحتاج pdftotext: يأتي مع Git لويندوز (mingw64/bin)، أو poppler-utils على لينكس، أو اضبط ABDO_PDFTOTEXT على مساره." }
  const pages = range === undefined ? [] : ["-f", String(range.from), ...(range.to === undefined ? [] : ["-l", String(range.to)])]
  const r = (options.spawn ?? defaultSpawn)([binary, "-enc", "UTF-8", "-layout", ...pages, file, "-"])
  if (r.exitCode !== 0) return { ok: false, error: `تعذّر استخراجُ نصّ PDF (رمز ${r.exitCode}): ${r.stderr.trim().slice(0, 200) || "بلا سبب"}` }
  const pageTexts = r.stdout.split("\f")
  if (pageTexts.length > 1 && pageTexts.at(-1)!.trim() === "") pageTexts.pop()
  const first = range?.from ?? 1
  const body = pageTexts.map((text, i) => `── صفحة ${first + i} ──\n${text.replace(/[ \t]+$/gmu, "").trimEnd()}`).join("\n\n")
  const empty = pageTexts.every((text) => text.trim().length === 0)
  const head = `📄 PDF: ${pageTexts.length} صفحة${range === undefined ? "" : ` (من ${first}${range.to === undefined ? "" : ` إلى ${range.to}`})`}${empty ? " — بلا طبقة نصّ (ممسوحٌ ضوئيّاً على الأرجح: لقطةُ الصفحة لنموذج الرؤية هي الطريق)" : ""}`
  const clipped = body.length > PDF_TEXT_CAP
    ? `${body.slice(0, PDF_TEXT_CAP)}\n[... قُصّ ${body.length - PDF_TEXT_CAP} حرفاً — اقرأ مقطعاً: read ${file.split(/[\\/]/u).pop()} <من صفحة> <إلى صفحة>]`
    : body
  return { ok: true, text: `${head}\n${clipped}` }
}
