import type { ProjectIdentityWrite } from "./project-identity-guard"
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** Narrow regression guard for literal authentication bypasses observed in
 * generated server source. Not a replacement for an authentication audit. */
export function projectAuthViolation(input: Pick<ProjectIdentityWrite, "normalizedTarget" | "after">): string | undefined {
  if (!/\.[cm]?[jt]sx?$/iu.test(input.normalizedTarget)) return undefined
  const source = input.after
  const nonemptyLiteral = `["'][^"'\\r\\n]+["']`
  const password = `(?:password|passwd|adminPassword|admin_password)`
  const literalComparison = new RegExp(`\\b${password}\\s*={2,3}\\s*${nonemptyLiteral}|${nonemptyLiteral}\\s*={2,3}\\s*${password}\\b`, "iu")
  const fallback = /process\.env\.[A-Z_]*(?:PASSWORD|PASSWD)[A-Z_]*\s*(?:\|\||\?\?)\s*["'][^"'\r\n]+["']/iu
  // مادّةُ توقيعٍ ثابتة: JWT_SECRET/SESSION_SECRET/API_KEY وأمثالها. قيس
  // حيّاً: `process.env.JWT_SECRET || "your-secret-key"` و`const JWT_SECRET =
  // "your-secret-key"` نجيا من قاعدة PASSWORD وحدها — والسرّ الثابت للتوقيع
  // ثغرةٌ مهما كان محتواه (placeholder أو لا)، لأنه يوقّع جلسات الإنتاج.
  const signingName = "(?:JWT|SESSION|SIGNING|COOKIE|AUTH|APP|ENCRYPTION|CSRF)[_-]?(?:SECRET|KEY|TOKEN|SALT)|SECRET[_-]?KEY"
  const signingFallback = new RegExp(`process\\.env\\.(?:${signingName})\\s*(?:\\|\\||\\?\\?)\\s*["'][^"'\\r\\n]+["']`, "iu")
  const signingLiteral = new RegExp(`\\b(?:const|let|var)\\s+\\w*(?:${signingName})\\w*\\s*=\\s*["'][^"'\\r\\n]{4,}["']`, "iu")
  // Hashing a literal is the same defect wearing a hash: the bootstrap admin
  // still ships with a password anyone can read. Observed live as
  // hashPassword("admin123") after the model replaced plaintext storage, and
  // the comparison/fallback rules above did not see it. Algorithm names such
  // as createHash("sha256") are excluded by requiring a password-named callee
  // or a known password-hashing API.
  // The literal is captured and judged in code, not by a lookahead: these
  // patterns need the `i` flag, and under it `[A-Z]` also matches lowercase, so
  // an inline SCREAMING_SNAKE exclusion silently swallows every literal.
  const capturedLiteral = `["']([^"'\\r\\n]+)["']`
  const isEnvName = (value: string) => /^[A-Z][A-Z0-9_]*$/.test(value)
  const namesACredential = (pattern: RegExp): boolean => {
    for (const match of source.matchAll(pattern)) {
      const literal = match[1]
      // An environment variable name is a lookup, not the secret itself.
      if (literal !== undefined && !isEnvName(literal)) return true
    }
    return false
  }
  // Test fixtures legitimately hash constants.
  const isTestSource = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(input.normalizedTarget)
  const literalIntoPasswordHasher = new RegExp(`\\b\\w*${password}\\w*\\s*\\(\\s*${capturedLiteral}`, "giu")
  const literalIntoKdf = new RegExp(`\\b(?:bcrypt|argon2|scrypt|pbkdf2)\\w*\\s*(?:\\.\\s*\\w+\\s*)?\\(\\s*${capturedLiteral}`, "giu")
  // A named default/seed credential is a fallback even when nothing reads it yet.
  const seededDefault = new RegExp(`\\b(?:default|initial|bootstrap|seed|temp|temporary)\\w*${password}\\w*\\s*[:=]\\s*${capturedLiteral}`, "giu")
  const hardcodedCredential = !isTestSource &&
    (namesACredential(literalIntoPasswordHasher) || namesACredential(literalIntoKdf) || namesACredential(seededDefault))
  if (literalComparison.test(source) || fallback.test(source) || hardcodedCredential) {
    return "تحقق الدخول يعتمد كلمة مرور ثابتة أو قيمة افتراضية داخل الشيفرة؛ استخدم إعداداً مطلوباً بلا fallback وحفظاً مشتقاً ومملحاً لكلمة المرور، وارفض الدخول عند غياب الإعداد"
  }
  // مادّة توقيعٍ ثابتة (JWT/جلسة): مرفوضة في مصدر المنتج، لا في الاختبارات.
  if (!isTestSource && (signingFallback.test(source) || signingLiteral.test(source))) {
    return "مادّة التوقيع (JWT/جلسة/مفتاح) ثابتةٌ في الشيفرة أو لها قيمة افتراضية؛ اقرأها من إعداد بيئةٍ مطلوب، وارفض التشغيل عند غيابه — لا سرّ توقيعٍ في المصدر مهما كان محتواه"
  }
  return undefined
}

/** Recheck already-existing first-party code so a resumed session cannot
 * bypass a new write guard. No dependency folders or symlinks are followed. */
export function projectAuthAudit(projectDir: string): string | undefined {
  const pending = ["app", "src", "lib", "server", "pages"].filter((name) => existsSync(join(projectDir, name)))
  let visited = 0
  try {
    while (pending.length > 0) {
      const relative = pending.pop()!
      if (lstatSync(join(projectDir, relative)).isSymbolicLink()) return `تدقيق المصادقة لا يتبع الرابط الرمزي ${relative}`
      for (const entry of readdirSync(join(projectDir, relative), { withFileTypes: true })) {
        if (++visited > 2_000) return "تدقيق المصادقة تجاوز حد ملفات المصدر؛ لا يوجد قبول أمني لهذا الفحص"
        const target = `${relative}/${entry.name}`
        if (entry.isSymbolicLink()) return `تدقيق المصادقة لا يتبع الرابط الرمزي ${target}`
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") pending.push(target)
        } else if (/\.[cm]?[jt]sx?$/iu.test(entry.name)) {
          if (statSync(join(projectDir, target)).size > 500_000) return `تدقيق المصادقة يتطلب مراجعة الملف الكبير ${target}`
          const violation = projectAuthViolation({ normalizedTarget: target, after: readFileSync(join(projectDir, target), "utf-8") })
          if (violation !== undefined) return `${target}: ${violation}`
        }
      }
    }
  } catch { return "تعذرت قراءة مصدر المشروع لتدقيق المصادقة؛ الفحص غير مثبت" }
  return undefined
}
