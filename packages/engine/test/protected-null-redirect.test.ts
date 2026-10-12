/**
 * 10-08 (مقيس): تشغيلُ Docker Desktop مع انتظارٍ بـ`docker info 2>$null` رُفض «مُثبَّتاتُ الجهاز… في أمرٍ يكتب» — والكتابةُ الوحيدة
 * توجيهٌ إلى العدم. والتوائم: الكتابةُ الحقيقيّة في Program Files وتوجيهٌ إلى ملفٍّ محميّ يبقيان رفضاً.
 */
import { expect, test } from "bun:test"
import { protectedCommandVerdict } from "../src/protected-paths"

const ENV = { APPDATA: "C:\\Users\\o\\AppData\\Roaming", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" }
const judge = (cmd: string) => protectedCommandVerdict(cmd, "C:\\work\\app", ENV)

test("launching an installed program while discarding output to $null / NUL is not a write", () => {
  expect(judge(`powershell -NoProfile -Command "Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'; while (-not (docker info 2>$null)) { Start-Sleep -Seconds 5 }; docker info"`).allowed).toBe(true)
  expect(judge(`"C:\\Program Files\\Git\\bin\\git.exe" status > NUL 2>&1`).allowed).toBe(true)
  expect(judge(`& 'C:\\Program Files\\nodejs\\node.exe' -v 2>/dev/null`).allowed).toBe(true)
})

test("the twins: a real write into Program Files, and a redirect into a protected file, stay refused", () => {
  expect(judge(`Remove-Item 'C:\\Program Files\\Docker\\x.dll' 2>$null`).allowed).toBe(false)
  expect(judge(`echo hi > "C:\\Program Files\\Docker\\note.txt"`).allowed).toBe(false)
  expect(judge(`docker info > C:\\Windows\\out.txt`).allowed).toBe(false)
  expect(judge(`echo x >$nullfile 'C:\\Program Files\\a'`).allowed).toBe(false)
})
