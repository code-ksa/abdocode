import { expect, test } from "bun:test"
import { addedLines, renderFindings, scanAdded } from "../src/diff-security-scan"

const diff = (file: string, added: readonly string[], start = 1) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +${start},${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n")

// شكلُ سرٍّ يُركَّب وقتَ التشغيل كي لا يحمل هذا الملفُّ نفسُه سرّاً يمسكه حارسُ الدفع.
const GH = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("")

test("added lines carry their real line numbers; removed and context lines are not scanned", () => {
  const text = ["--- a/x.ts", "+++ b/x.ts", "@@ -10,2 +10,3 @@", " keep", "-gone", "+new one", "+new two"].join("\n")
  expect(addedLines(text)).toEqual([{ file: "x.ts", line: 11, text: "new one" }, { file: "x.ts", line: 12, text: "new two" }])
  expect(addedLines(["--- a/y.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n"))).toEqual([])
})

test("a secret shape, a committed env file and a hardcoded credential are high — and the value is never echoed", () => {
  const found = scanAdded([
    ...addedLines(diff("src/api.ts", [`const token = "${GH}"`])),
    ...addedLines(diff(".env", ["DB_URL=postgres://u:p@h/db"])),
    ...addedLines(diff("src/db.ts", ['const config = { password: "S3cure!Passw0rd" }'])),
  ])
  expect(found.filter((f) => f.severity === "high").map((f) => f.rule).sort()).toEqual(["hardcoded-credential", "secret-file", "secret:github_token"])
  const text = renderFindings(found)
  expect(text).not.toContain(GH)
  expect(text).not.toContain("S3cure!Passw0rd")
  expect(text).toContain("src/api.ts:1")
})

test("vulnerability patterns in code are flagged; the same words in a comment or a placeholder are not (the twins)", () => {
  const code = scanAdded(addedLines(diff("s.ts", [
    "https.request({ rejectUnauthorized: false })",
    "execSync(`git log ${userInput}`)",
    "db.query(\"SELECT * FROM users WHERE id=\" + req.params.id)",
    "el.innerHTML = userHtml",
    "const f = eval(body)",
  ])))
  expect(code.map((f) => f.rule)).toEqual(["tls-verify-off", "shell-injection", "sql-concat", "xss-sink", "eval"])
  const quiet = scanAdded(addedLines(diff("s.ts", [
    "// never use rejectUnauthorized: false here",
    "el.innerHTML = \"<b>fixed</b>\"",
    "const config = { password: process.env.DB_PASSWORD }",
    "const sample = { api_key: \"<your-api-key>\" }",
    "db.query(\"SELECT * FROM users WHERE id = $1\", [id])",
  ])))
  expect(quiet).toEqual([])
  expect(scanAdded(addedLines(diff(".env.example", ["DB_URL=postgres://user:pass@host/db"])))).toEqual([])
  expect(renderFindings([])).toContain("لا سرَّ ولا نمطَ ثغرة")
})
