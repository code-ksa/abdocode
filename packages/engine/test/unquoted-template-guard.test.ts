/**
 * 10-08 (مقيس): `run docker version --format {{.Server.Version}}` ⇦ «unknown shorthand flag: 'i' in -inputFormat» — PowerShell قرأ
 * القالبَ كتلةَ سكربت. الحارسُ يعيد الأمرَ مقتبساً؛ والتوائم: المقتبسُ يمرّ، وما بلا قالبٍ يمرّ.
 */
import { expect, test } from "bun:test"
import { unquotedTemplateViolation } from "../src/shell-command-guard"

test("an unquoted Go template is refused with the corrected command", () => {
  expect(unquotedTemplateViolation("docker version --format {{.Server.Version}}")).toContain("أعد: run docker version --format '{{.Server.Version}}'")
  expect(unquotedTemplateViolation("docker ps --format={{.Names}}")).toContain("run docker ps --format='{{.Names}}'")
  expect(unquotedTemplateViolation("docker inspect -f {{.State.Running}} web")).toContain("run docker inspect -f '{{.State.Running}}' web")
})

test("the twins: a quoted template, a script block with single braces, and plain commands pass", () => {
  expect(unquotedTemplateViolation("docker ps --format '{{.Names}}'")).toBeUndefined()
  expect(unquotedTemplateViolation('docker ps --format "{{.Names}}"')).toBeUndefined()
  expect(unquotedTemplateViolation("Get-ChildItem | ForEach-Object { $_.Name }")).toBeUndefined()
  expect(unquotedTemplateViolation("npm run build")).toBeUndefined()
})
