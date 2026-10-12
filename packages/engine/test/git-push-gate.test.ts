/**
 * 10-08 — git push نشرٌ إلى خارج الجهاز: يُسأل عنه دائماً ولو في نمط الوصول الكامل (كـpr-create)، والرفضُ يعود سبباً صريحاً.
 * فحصُ مصدر: البوّابةُ في run قبل التنفيذ، بـalways، وبنمطٍ يلتقط push بعد فاصل أو -C.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
const PUSH = /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?push\b/iu

test("git push asks every time, before the command runs", () => {
  expect(cli).toContain('"git-push", { always: true })) return refused("رُفض git push')
  const runExec = cli.indexOf("const runExecV = async")
  const gateAt = cli.indexOf('"git-push", { always: true })')
  const spawnAt = cli.indexOf("launchControlledProcess", runExec)
  expect(runExec).toBeGreaterThan(0)
  expect(gateAt).toBeGreaterThan(runExec)
  if (spawnAt > 0) expect(gateAt).toBeLessThan(spawnAt)
})

test("the push pattern: chained and -C forms are caught; other git verbs and words are not", () => {
  for (const c of ["git push", "git push origin main", "git add . && git push", "git -C ../x push -u origin HEAD", "npm test; git push"]) expect(PUSH.test(c)).toBe(true)
  for (const c of ["git pull", "git status", "echo pushed", "git commit -m 'push later'"]) expect(PUSH.test(c)).toBe(false)
})
