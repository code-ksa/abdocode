/**
 * 10-08 — المهمّة الكاملة (abdo-router): «secrets import .env completed: 9 keys stored in vault … grep confirms no secret values» رُفض مرّتين
 * «لا يسمّي قياساً». سبرنتُ الأسرار والنشر يُقاس بأدواته: secrets list/import، grep، server test، deploy — بعد آخر تعديل.
 */
import { expect, test } from "bun:test"
import { newEvidenceClock, noteEvidence, sprintEvidenceRefusal } from "../src/sprint-evidence"

const measured = "secrets import .env completed: 9 keys stored in vault (.abdo/secrets.json), .env.example exists, grep confirms no secret values in committed files"

test("the refused evidence closes once a secrets/grep measurement exists after the last edit", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "edit .gitignore :: .env => .env*", true, 1_000)
  expect(sprintEvidenceRefusal(measured, clock)).toContain("تشغيليّاً ناجحاً")
  noteEvidence(clock, "secrets import .env", true, 2_000, "🔐 حُفظ 9 مفتاحاً في الخزنة (القيمُ لم تُعرض)")
  expect(sprintEvidenceRefusal(measured, clock)).toBeUndefined()
})

test("a measurement older than the last edit, or a failed one, does not count", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "secrets list", true, 1_000, "أسرارُ المشروع (2 — أسماءٌ لا قيم)")
  noteEvidence(clock, "write lib/keys.ts <<<", true, 2_000)
  expect(sprintEvidenceRefusal(measured, clock)).toBeDefined()
  noteEvidence(clock, "server test prod", true, 3_000, "تعذّر الاتّصال بـ«prod»: Permission denied")
  expect(sprintEvidenceRefusal("server test passes", clock)).toBeDefined()
  noteEvidence(clock, "server test prod", true, 4_000, "متّصلٌ بـ«prod»: system: Linux")
  expect(sprintEvidenceRefusal("server test passes: connected", clock)).toBeUndefined()
})

test("deploy evidence is measured by a deploy that published", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "deploy test --env", true, 1_000, "✕ لم يكتمل النشر إلى «test»")
  expect(sprintEvidenceRefusal("deploy --env to the test server", clock)).toBeDefined()
  noteEvidence(clock, "deploy test --env", true, 2_000, "✓ نُشر إلى «test»")
  expect(sprintEvidenceRefusal("deploy --env to the test server", clock)).toBeUndefined()
})

// 10-08 (measured on abdo-router): both evidence lines for a deploy that published with a 200 check were refused.
test("a deploy that published with a passing check measures the page too; English and Arabic deploy wording count", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "write app/api/health/route.ts <<<", true, 1_000)
  noteEvidence(clock, 'deploy local-docker --env --check http://127.0.0.1:3000/api/health', true, 2_000, "✓ نُشر إلى «local-docker»\n✓ check: http://127.0.0.1:3000/api/health (من الخادم نفسِه) → 200")
  expect(sprintEvidenceRefusal('health endpoint returned HTTP 200 with {status:"ok"} after deploying to local Docker server', clock)).toBeUndefined()
  expect(sprintEvidenceRefusal("الصحة نجحت بعد النشر إلى خادم Docker المحلي", clock)).toBeUndefined()
})

test("a deploy whose check failed does not measure the page", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "deploy box --check http://127.0.0.1:3000/", true, 2_000, "✓ نُشر إلى «box»\n✕ check: http://127.0.0.1:3000/ → لا ردّ")
  expect(sprintEvidenceRefusal("HTTP 200 after deploying", clock)).toBeDefined()
})
