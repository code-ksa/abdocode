/**
 * 10-11 (مقيس على n8n-clone): دورٌ بـ222 أداة — release-check ‏PASS 7/7 في الحقبة 4 ثمّ «sprint done 16» ثمّ عشراتُ القراءات؛ المحكّمُ رأى
 * آخرَ ثمانية إيصالاتٍ فحكم «PASS مذكورٌ بلا إيصال». يُقاس على النصّ الذي يصل المحكّمَ فعلاً.
 */
import { expect, test } from "bun:test"
import { buildVerifierPrompt, gateKey } from "../src/semantic-verifier"

const turn = () => {
  const receipts: { command: string; output: string }[] = []
  receipts.push({ command: "release-check", output: "release-check: FAIL — 5/7 مرحلة\n✗ build-routes: /x 500\n" + "△ warn\n".repeat(80) })
  for (let i = 0; i < 40; i += 1) receipts.push({ command: `read app/page-${i}.tsx`, output: "x".repeat(900) })
  receipts.push({ command: "release-check", output: "release-check: PASS — 7/7 مرحلة\n✓ code-checks: 0 خطأ\n" + "△ hardcoded-localhost .abdo/reference/x.js\n".repeat(60) })
  receipts.push({ command: "sprint done 16 :: release-check PASS 7/7", output: "✓ S16 أُغلق" })
  receipts.push({ command: "run npm run build", output: "▲ Next.js 15\n✓ Compiled successfully\nانتهى الأمر برمز 0" })
  for (let i = 0; i < 170; i += 1) receipts.push({ command: `grep foo app/page-${i}.tsx`, output: "y".repeat(800) })
  return receipts
}

test("the latest receipt of every gate reaches the verifier even 170 receipts later — verdict line first", () => {
  const prompt = buildVerifierPrompt("S16 — التحقق النهائي", "release-check PASS 7/7", turn())
  expect(prompt).toContain("$ release-check\nrelease-check: PASS — 7/7 مرحلة")
  expect(prompt).toContain("$ sprint done 16 :: release-check PASS 7/7")
  expect(prompt).toContain("✓ Compiled successfully")
  // the newest receipts still come in too
  expect(prompt).toContain("$ grep foo app/page-169.tsx")
})

test("the twin: an older run of the same gate is not shown — only its latest verdict", () => {
  const prompt = buildVerifierPrompt("S16", "done", turn())
  expect(prompt).not.toContain("release-check: FAIL — 5/7")
  expect(prompt.length).toBeLessThan(20_000)
})

test("gateKey names gates and nothing else", () => {
  expect(gateKey("release-check")).toBe("release-check")
  expect(gateKey("sprint done 12 :: verify-s12: PASS")).toBe("sprint done 12")
  expect(gateKey("run npm run build")).toBe("run npm run build")
  expect(gateKey("run npm test")).toBe("run npm test")
  expect(gateKey("run npm audit --audit-level=high")).toBe("run npm audit")
  expect(gateKey("audit / /pricing --port 3001")).toBe("audit")
  expect(gateKey("read app/page.tsx")).toBeUndefined()
  expect(gateKey("run npm install")).toBeUndefined()
  expect(gateKey("auditor.ts")).toBeUndefined()
})

// 10-11 (مقيس على m11 بعاملَين): «اعمل بعاملين» — المحكّمُ لم يرَ إيصالَ parallel (أزاحته 26 أداةً أحدث) فحجب «لا دليلَ على عاملَين».
test("the workers report and each merge reach the verifier after many later receipts", () => {
  const receipts: { command: string; output: string }[] = [
    { command: "parallel <<<\nعامل الواجهة\nعامل الخادم", output: "🧵 عمّالٌ متوازون: 2 — [1] completed WORKERS_REPORT\n" + "z".repeat(1500) },
    { command: "merge abdocode/task-aaaaaaaa", output: "✓ طُبّق فرقُ abdocode/task-aaaaaaaa MERGED_A" },
    { command: "merge abdocode/task-bbbbbbbb", output: "✓ طُبّق فرقُ abdocode/task-bbbbbbbb MERGED_B" },
  ]
  for (let i = 0; i < 60; i += 1) receipts.push({ command: `read src/f-${i}.js`, output: "q".repeat(900) })
  const prompt = buildVerifierPrompt("اعمل بعاملين", "done", receipts)
  expect(prompt).toContain("WORKERS_REPORT")
  expect(prompt).toContain("MERGED_A")
  expect(prompt).toContain("MERGED_B")
  expect(gateKey("merge abdocode/task-aaaaaaaa")).toBe("merge abdocode/task-aaaaaaaa")
})
