/**
 * فحصُ الفرق أمنيّاً قبل الإيداع — البند 3 في برنامج «أكفأ من Codex» (2026-09-28).
 *
 * الفجوةُ المقيسة: حرّاسُنا كثيرة (الأوامر، الخروج، الوارد، المسارات)، لكن **ما يُكتب في المستودع** لم يكن يُفحص: لا ماسحَ
 * أسرارٍ للفرق ولا عدسةَ ثغرات — والنصوصُ التي تُسرَّب إلى مستودعٍ عامّ لا تُسحب (ذاكرة public-repo-leaked-internal-decisions).
 *
 * حتميٌّ بلا نموذج ولا شبكة: يقرأ الأسطرَ **المضافة** من فرقٍ موحَّد (`git diff -U0`)، ويسمّي لكلّ نتيجةٍ ملفَّها وسطرَها
 * وقاعدتَها وخطورتَها — ولا يعيد القيمةَ السرّيّة أبداً (أشكالُ الأسرار من مالكها الواحد `@abdo/tools/secrets`).
 * «high» تُوقف الإيداع؛ «medium» تُقال ولا تمنع. والنمطُ يُطابق الشيفرةَ لا التعليق حيث يمكن التمييز.
 */
import { redactCounted } from "@abdo/tools/secrets"

export type ScanSeverity = "high" | "medium"
export interface AddedLine { readonly file: string; readonly line: number; readonly text: string }
export interface ScanFinding { readonly file: string; readonly line: number; readonly severity: ScanSeverity; readonly rule: string; readonly why: string }

/** الأسطرُ المضافة من فرقٍ موحَّد، بأرقامها في الملفّ الجديد. الملفُّ المحذوف (/dev/null) لا يُفحص. */
export function addedLines(unifiedDiff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file: string | undefined
  let line = 0
  for (const raw of unifiedDiff.split(/\r?\n/u)) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim()
      file = target === "/dev/null" ? undefined : target.replace(/^b\//u, "")
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(raw)
    if (hunk !== null) { line = Number(hunk[1]); continue }
    if (file === undefined || raw.startsWith("--- ")) continue
    if (raw.startsWith("+")) { out.push({ file, line, text: raw.slice(1) }); line += 1; continue }
    if (raw.startsWith(" ")) line += 1
  }
  return out
}

/** ملفّاتٌ لا تُودَع أصلاً: بيئةٌ حقيقيّة ومفاتيحُ خاصّة (والقوالبُ .example/.sample/.template مستثناة). */
const SECRET_FILE = /(?:^|\/)\.env(?:\.[\w-]+)?$|(?:^|\/)id_(?:rsa|ed25519|ecdsa)$|\.(?:pem|p12|pfx|key)$/iu
const TEMPLATE_FILE = /\.(?:example|sample|template|dist)$/iu
const COMMENT_ONLY = /^\s*(?:\/\/|#|\*|\/\*|<!--|--)/u
/** قيمٌ نائبة لا تُعدّ اعتماداً: متغيّرٌ أو قالبٌ أو نصٌّ وصفيّ. */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|changeme|change-me|your[-_ ]|example|placeholder|dummy|test|redacted|«)/iu

interface Rule { readonly id: string; readonly severity: ScanSeverity; readonly re: RegExp; readonly why: string; readonly codeOnly?: boolean }
const RULES: readonly Rule[] = [
  { id: "tls-verify-off", severity: "high", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|InsecureSkipVerify\s*:\s*true|verify\s*=\s*False\b|ssl\._create_unverified_context|curl\b[^\n]*\s(?:-k|--insecure)\b/u, why: "إطفاءُ التحقّق من شهادة TLS يفتح الاتصالَ لرجلٍ في المنتصف", codeOnly: true },
  { id: "eval", severity: "medium", re: /(?<![\w.])eval\s*\(|new\s+Function\s*\(/u, why: "تنفيذُ نصٍّ كشيفرة — خطرٌ إن وصله مدخلُ مستخدم", codeOnly: true },
  { id: "shell-injection", severity: "medium", re: /\b(?:execSync|exec)\s*\(\s*`[^`]*\$\{|\bos\.system\s*\([^)]*[+%]|\bsubprocess\.[a-z_]+\([^)]*shell\s*=\s*True/u, why: "أمرُ صَدَفةٍ يُبنى من نصٍّ متغيّر — حقنُ أوامر", codeOnly: true },
  { id: "sql-concat", severity: "medium", re: /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+\s*[\w$]|`\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/iu, why: "استعلامُ SQL يُبنى بالوصل — استعمل معاملاتٍ مربوطة", codeOnly: true },
  { id: "xss-sink", severity: "medium", re: /dangerouslySetInnerHTML|\.(?:innerHTML|outerHTML)\s*=(?!\s*["'`][^"'`$]*["'`]\s*;?\s*$)/u, why: "نصٌّ متغيّر إلى HTML مباشرةً — XSS", codeOnly: true },
]
const CREDENTIAL = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/iu

/** يفحص الأسطرَ المضافة ويعيد نتائجَ مسمّاةً بلا قيمةٍ سرّيّة. */
export function scanAdded(lines: readonly AddedLine[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  const seenFile = new Set<string>()
  for (const { file, line, text } of lines) {
    if (!seenFile.has(file)) {
      seenFile.add(file)
      if (SECRET_FILE.test(file) && !TEMPLATE_FILE.test(file)) findings.push({ file, line, severity: "high", rule: "secret-file", why: "ملفُّ بيئةٍ أو مفتاحٍ خاصّ لا يُودَع — مكانُه الخزنة" })
    }
    const secrets = redactCounted(text)
    if (secrets.redactions.count > 0) findings.push({ file, line, severity: "high", rule: `secret:${secrets.redactions.kinds.join("+")}`, why: "شكلُ سرٍّ في سطرٍ مضاف — أخرجه إلى الخزنة، وعدَّه محروقاً إن كان حقيقيّاً" })
    const credential = CREDENTIAL.exec(text)
    if (credential !== null && !PLACEHOLDER.test(credential[1] ?? "") && secrets.redactions.count === 0) findings.push({ file, line, severity: "high", rule: "hardcoded-credential", why: "اعتمادٌ مكتوبٌ في الشيفرة — يُقرأ من البيئة أو الخزنة" })
    const comment = COMMENT_ONLY.test(text)
    for (const rule of RULES) {
      if (rule.codeOnly === true && comment) continue
      if (rule.re.test(text)) findings.push({ file, line, severity: rule.severity, rule: rule.id, why: rule.why })
    }
  }
  return findings
}

/** سطرٌ لكلّ نتيجة، والأخطرُ أوّلاً — بلا قيمة: الملفُّ والسطرُ والقاعدةُ والسبب. */
export function renderFindings(findings: readonly ScanFinding[], limit = 20, title = "فحصُ الفرق"): string {
  if (findings.length === 0) return `🛡 ${title}: لا سرَّ ولا نمطَ ثغرةٍ في الأسطر المضافة.`
  const sorted = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1))
  const high = findings.filter((f) => f.severity === "high").length
  const head = `🛡 ${title}: ${high} خطيرة · ${findings.length - high} للمراجعة`
  const rows = sorted.slice(0, limit).map((f) => `${f.severity === "high" ? "⛔" : "⚠"} ${f.file}:${f.line} · ${f.rule} — ${f.why}`)
  return [head, ...rows, ...(findings.length > limit ? [`…و${findings.length - limit} أخرى`] : [])].join("\n")
}
