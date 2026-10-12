/**
 * 10-08 (مقيس): `run echo "Task completed: local server works, Docker deployment blocked…"` ستَّ مرّاتٍ بصيغٍ مختلفة — كلامٌ بالأداة.
 * والتوائم: صدى قصير، أو إلى ملفّ، أو بمتغيّر، أو جزءٌ من أمرٍ مركّب — كلُّها تمرّ.
 */
import { expect, test } from "bun:test"
import { narrationEchoViolation } from "../src/shell-command-guard"

test("an echoed sentence with nothing else is narration, refused with the route to plain text", () => {
  expect(narrationEchoViolation(`echo "Task completed: local server works, Docker deployment blocked by system policy. Results documented in RESULT.txt"`)).toContain("كلامٌ لا أداة")
  expect(narrationEchoViolation(`Write-Host 'All required steps have been performed and the server works locally as expected now'`)).toContain("كلامٌ لا أداة")
  expect(narrationEchoViolation(`echo "تمّ تنفيذ كلّ الخطوات المطلوبة والخادم يعمل محلّياً كما هو متوقّع الآن"`)).toContain("كلامٌ لا أداة")
})

test("the twins: short, redirected, variable or compound echoes pass", () => {
  expect(narrationEchoViolation(`echo ok`)).toBeUndefined()
  expect(narrationEchoViolation(`echo "a much longer line that is written into a file for the build" > out.txt`)).toBeUndefined()
  expect(narrationEchoViolation(`echo "the current path variable is shown here for debugging $env:PATH now"`)).toBeUndefined()
  expect(narrationEchoViolation(`Write-Host "Building the project now, please wait a little while"; npm run build`)).toBeUndefined()
  expect(narrationEchoViolation(`npm run build`)).toBeUndefined()
})
