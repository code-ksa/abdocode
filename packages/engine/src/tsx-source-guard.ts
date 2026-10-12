import type { ProjectIdentityWrite } from "./project-identity-guard"

const syntaxParsers = {
  tsx: new Bun.Transpiler({ loader: "tsx", target: "browser" }),
  jsx: new Bun.Transpiler({ loader: "jsx", target: "browser" }),
  ts: new Bun.Transpiler({ loader: "ts", target: "browser" }),
  js: new Bun.Transpiler({ loader: "js", target: "browser" }),
}

/**
 * 10-08 (مقيس على موقع Next.js): «صياغة tsx غير صالحة: BuildMessage: Syntax Error» بلا موضع — أعاد النموذجُ كتابةَ الملفّ نفسِه عشرَ مرّاتٍ
 * في دورٍ واحد ولم يرَ أنّ العيبَ سطرٌ واحد (`>,` مكان `</>,`، أو «»» ملصقةٌ بعد آخر سطر). المحلّلُ يعرف السطرَ والعمود — يُعرضان مع ما حولهما.
 */
export function syntaxErrorExcerpt(source: string, error: unknown): string {
  const of = (e: unknown) => (e as { position?: { line?: number; column?: number } } | undefined)?.position
  const position = of(error) ?? of((error as { errors?: unknown[] } | undefined)?.errors?.[0])
  const line = position?.line
  if (typeof line !== "number" || line < 1) return ""
  const lines = source.split(/\r?\n/u)
  if (line > lines.length) return ` — عند السطر ${line}`
  const from = Math.max(1, line - 2), to = Math.min(lines.length, line + 2)
  const rows: string[] = []
  for (let n = from; n <= to; n += 1) rows.push(`${n === line ? ">" : " "} ${String(n).padStart(String(to).length)} | ${lines[n - 1]!.slice(0, 160)}`)
  return ` — عند السطر ${line}:${position?.column ?? 0}\n${rows.join("\n")}`
}

/** Refuse prose/pseudocode in source; component shape checks apply only to JSX. */
export function tsxSourceViolation(input: ProjectIdentityWrite): string | undefined {
  if (!/\.[cm]?[jt]sx?$/iu.test(input.normalizedTarget)) return undefined
  const jsx = /\.[jt]sx$/iu.test(input.normalizedTarget)
  const loader = /\.tsx$/iu.test(input.normalizedTarget) ? "tsx" : /\.jsx$/iu.test(input.normalizedTarget) ? "jsx" : /\.[cm]?ts$/iu.test(input.normalizedTarget) ? "ts" : "js"
  // Parse only: never import, evaluate, or resolve model-authored source.
  // Check the resulting bytes for edits too, before the atomic writer runs.
  try {
    syntaxParsers[loader].transformSync(input.after)
  } catch (error) {
    return `صياغة ${loader} غير صالحة: ${String(error instanceof Error ? error.message : error).slice(0, 600)}${syntaxErrorExcerpt(input.after, error)}`
  }
  if (!jsx) return undefined
  // ملفُ دخولٍ يركّب التطبيق (createRoot/hydrateRoot/render) سكربتٌ لا
  // مكوّن — لا export له شرعاً. قيس حيّاً: الحارس صدّ src/main.tsx الصحيح
  // مرتين في جولة Vite (حارسُ عصر Next يحاكم ملفات عصرٍ آخر).
  const isMountingEntry = /\b(?:createRoot|hydrateRoot)\s*\(|ReactDOM\.render\s*\(/u.test(input.after)
  // ملف اختبار (describe/it/test) سكربتٌ يشغّله العدّاء — لا export له شرعاً.
  // قيس حيّاً (RN 2026-08-31): الرفض دفع النموذج للفّ الاختبارات في سلسلة
  // export const «ترضي الحارس» فصارت suite فارغة خضراء الشكل ميتة الفعل.
  const isTestFile = /\.(?:test|spec)\.[cm]?[jt]sx$/iu.test(input.normalizedTarget)
  if (!/\bexport\b/u.test(input.after) && !isMountingEntry && !isTestFile) return "ملف TSX بلا export"
  if (!/<(?:[A-Z][\w.]*|[a-z][\w-]*)\b/u.test(input.after)) return "ملف TSX بلا عناصر JSX"
  return undefined
}
