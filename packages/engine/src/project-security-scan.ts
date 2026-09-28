/**
 * `security scan [مسار]` — فحصُ المشروع كلِّه أمنيّاً (برنامج «أكفأ من Codex» البند 3، 2026-09-28). فحصُ الفرق يحرس ما يُضاف؛
 * وما أُودع قبله — سرٌّ منسيٌّ في ملفّ إعداد، eval قديم — لا يراه أحد. القواعدُ هي هي (diff-security-scan.ts، مالكٌ واحد)،
 * والنطاقُ ملفّاتُ git المتتبَّعة وحدها: ما في .gitignore ليس في المستودع، والثنائيُّ والضخمُ يُتخطّيان ويُعدّان.
 * حتميٌّ بلا نموذج ولا شبكة، ولا يعيد قيمةَ سرٍّ أبداً.
 */
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { renderFindings, scanAdded, type AddedLine, type ScanFinding } from "./diff-security-scan"

export type GitRun = (args: readonly string[]) => { readonly ok: boolean; readonly out: string }

const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 5000

/** `security scan` أو «افحص المشروع أمنيّاً» مع مسارٍ اختياريّ — أو لا شيء. */
export function parseSecurityScan(body: string): { readonly path?: string } | { readonly error: string } | undefined {
  const m = /^\/?(?:security\s+scan|افحص\s+(?:المشروع\s+)?(?:أمنيّاً|أمنياً|امنيا|أمنيا|الأمن))(?:\s+(\S+))?\s*$/iu.exec(body.trim())
  if (m === null) return undefined
  const path = m[1]
  if (path === undefined) return {}
  if (path.startsWith("-") || path.split(/[\\/]/u).includes("..")) return { error: `security scan [مسارٌ داخل المشروع] — لا «${path.slice(0, 40)}».` }
  return { path }
}

export interface ProjectScan { readonly findings: readonly ScanFinding[]; readonly files: number; readonly lines: number; readonly skipped: number; readonly capped: boolean }

export function scanProject(root: string, git: GitRun, path?: string): ProjectScan | { readonly error: string } {
  const listed = git(["ls-files", "-z", ...(path === undefined ? [] : ["--", path])])
  if (!listed.ok) return { error: "security scan يفحص ملفّاتِ مستودع git المتتبَّعة — المشروعُ ليس مستودعاً (git init أوّلاً)." }
  const all = listed.out.split("\0").filter((f) => f.length > 0)
  const files = all.slice(0, MAX_FILES)
  const lines: AddedLine[] = []
  let skipped = 0
  for (const file of files) {
    try {
      const abs = join(root, file)
      if (statSync(abs).size > MAX_FILE_BYTES) { skipped += 1; continue }
      const bytes = readFileSync(abs)
      if (bytes.subarray(0, 8192).includes(0)) { skipped += 1; continue }
      bytes.toString("utf8").split(/\r?\n/u).forEach((text, i) => lines.push({ file, line: i + 1, text }))
    } catch { skipped += 1 }
  }
  return { findings: scanAdded(lines), files: files.length - skipped, lines: lines.length, skipped, capped: all.length > files.length }
}

export function renderProjectScan(scan: ProjectScan, path?: string): string {
  const high = scan.findings.filter((f) => f.severity === "high").length
  const head = `🛡 فحصٌ أمنيّ${path === undefined ? " للمشروع" : ` لـ«${path}»`}: ${scan.files} ملفّاً متتبَّعاً، ${scan.lines} سطراً${scan.skipped > 0 ? ` (تُخطّي ${scan.skipped} ثنائيّاً أو أكبر من 512KB)` : ""}${scan.capped ? ` — أوّلُ ${MAX_FILES} ملفّ فقط` : ""}.`
  if (scan.findings.length === 0) return `${head}\nلا نتيجة بالقواعد الحتميّة (أسرار، مفاتيح، TLS مطفأ، eval، حقنُ صدفة وSQL، XSS). هذا فحصُ أنماطٍ لا مراجعةُ منطق.`
  return `${head}\n${renderFindings(scan.findings, 40, "النتائج")}${high > 0 ? "\n⛔ الخطيرةُ لا تُدفع قبل معالجتها — والسرُّ الذي أُودع يُعدّ محروقاً ويُدوَّر." : ""}`
}
