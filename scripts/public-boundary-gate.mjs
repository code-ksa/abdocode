import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

// 09-14 (أمرُ المالك «أمّن المستودع العامّ»): الجذورُ كلُّ ما يُشحن، لا ثلاثةً منها — وما لا يوجد في الشجرة يُتخطّى.
const roots = ["packages", "architecture", existsSync("public-docs") ? "public-docs" : "docs", "extensions", "scripts", "legal", "README.md", "AGENTS.md", "llms.txt", "CONTRIBUTING.md", "package.json"]
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".mdx", ".html", ".astro", ".rs", ".toml", ".yml", ".yaml"])
const PRIVATE_MARKERS = ["VXNlcnNcYWJkZWxyYWhtYW4=", "VXNlcnMvYWJkZWxyYWhtYW4=", "YWxraGFkcmFhMDI=", "dGtzYS1zZXJ2ZXI=", "d29tZW5tb2RhMjI=", "YWJkby1jb2RlLWFsLWFraGJhcmk=", "YWdlbnQtYWRtaW4=", "QWJkZWxyYWhtYW4=", "QWJvdWlzbWFpbA==", "QWJ1IElzbWFpbA==", "2LnYqNiv2KfZhNix2K3ZhdmG", "2LnYqNivINin2YTYsdit2YXZhg==", "2KPYqNmIINil2LPZhdin2LnZitmE", "2KPYqNmI2KfYs9mF2KfYudmK2YQ="].map((x) => Buffer.from(x, "base64").toString("utf8"))
const forbidden = [
  ["abdo-code-", "latest"].join(""),
  ["abdo", "3"].join(""),
  ["agent", "-admin"].join(""),
  ["agent", "admin"].join(""),
  ["Abdo", "Code3"].join(""),
  ["C:", "\\agent", "-admin"].join(""),
  ["Mopar", "Meg"].join(""),
  ["Edu", "Global"].join(""),
  ["Mubar", "mij"].join(""),
  // مساراتُ جهاز المطوّر وحساباتُه الخاصّة وخوادمُه — مرمَّزةٌ base64 كي لا يحمل السكربتُ نفسُه (وهو يُشحن) الأسماءَ حرفيّاً.
  ...PRIVATE_MARKERS,
]
// الحارسان اللذان يبحثان عن الأسماء يحملانها بالضرورة — يُستثنيان من الفحص لا من الشحن.
const SELF_GATES = new Set(["scripts/two-lines-gate.mjs", "scripts/public-boundary-gate.mjs"])
const findings = []
let scanned = 0
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "target", "dist", ".git"].includes(name)) continue
    const path = join(directory, name)
    if (SELF_GATES.has(relative(".", path).replace(/\\/g, "/"))) continue // حرّاسٌ تحمل الأسماءَ بحكم وظيفتها (تبحث عنها)
    if (statSync(path).isDirectory()) walk(path)
    else if (extensions.has(extname(path))) {
      scanned++
      const text = readFileSync(path, "utf8")
      for (const token of forbidden) if (text.toLowerCase().includes(token.toLowerCase())) findings.push(`${relative(".", path)}: forbidden private-product marker`)
    }
  }
}
// ملفّاتُ النَّسَب (README/AGENTS/llms) تذكر مبرمج وتكنولوجيا السعودية بأمر المالك — يُفحص فيها المسارُ والحسابُ الخاصّ لا الاسمُ التجاريّ.
const CREDIT_FILES = new Set(["README.md", "AGENTS.md", "llms.txt", "CONTRIBUTING.md", "package.json"])
const privateOnly = PRIVATE_MARKERS
for (const root of roots) { if (!existsSync(root)) continue; if (statSync(root).isDirectory()) walk(root); else { scanned++; const text = readFileSync(root, "utf8"); for (const token of (CREDIT_FILES.has(root) ? privateOnly : forbidden)) if (text.toLowerCase().includes(token.toLowerCase())) findings.push(`${root}: forbidden private-product marker`) } }
if (findings.length) { console.error(`PUBLIC_BOUNDARY_FAILED (${findings.length})\n${findings.join("\n")}`); process.exit(1) }
console.log(`PUBLIC_BOUNDARY_OK files=${scanned} forbidden=0`)
