import type { ProjectIdentityWrite } from "./project-identity-guard"

const syntaxParsers = {
  tsx: new Bun.Transpiler({ loader: "tsx", target: "browser" }),
  jsx: new Bun.Transpiler({ loader: "jsx", target: "browser" }),
  ts: new Bun.Transpiler({ loader: "ts", target: "browser" }),
  js: new Bun.Transpiler({ loader: "js", target: "browser" }),
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
    return `صياغة ${loader} غير صالحة: ${String(error instanceof Error ? error.message : error).slice(0, 600)}`
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
