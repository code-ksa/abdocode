/**
 * 10-08 — بروفة النشر: `logs bg-1` خمسَ مرّاتٍ في ١٥ ثانيةً والبناءُ جارٍ، ثمّ «duplicate». قراءةٌ ثانية لتشغيلٍ جارٍ لم يزد سجلُّه تنتظر
 * خرجاً جديداً (لا تعيد النصَّ نفسَه فوراً)، والأولى والمعرّفُ المجهول لا ينتظران. (السجلُّ يُمَدّ من الاختبار: PowerShell يخزّن خرجَه فلا يُعتمد توقيتُه.)
 */
import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backgroundLogsAwaitingNew, startBackgroundRun, stopAllBackgroundRuns } from "../src/background-runs"

test("a second logs call on a running job waits for new output instead of returning the same text at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-logs-"))
  try {
    const run = await startBackgroundRun("Start-Sleep -Seconds 30", dir, dir, process.env)
    const t0 = Date.now()
    expect(await backgroundLogsAwaitingNew(run.id, 20, 10_000, 50)).toContain("جارٍ")
    expect(Date.now() - t0).toBeLessThan(1_000) // the first read never waits
    setTimeout(() => appendFileSync(run.log, "step 2/5 done\n"), 1_500)
    const t1 = Date.now()
    const again = await backgroundLogsAwaitingNew(run.id, 20, 10_000, 50)
    const waited = Date.now() - t1
    expect(again).toContain("step 2/5 done")
    expect(waited).toBeGreaterThan(1_200)
    expect(waited).toBeLessThan(5_000)
    // nothing new and a short ceiling: it returns at the ceiling, still running
    const t2 = Date.now()
    const idle = await backgroundLogsAwaitingNew(run.id, 20, 800, 50)
    expect(Date.now() - t2).toBeGreaterThanOrEqual(700)
    expect(idle).toContain("جارٍ")
  } finally {
    stopAllBackgroundRuns()
    await Bun.sleep(300)
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test("an unknown id answers at once", async () => {
  const t0 = Date.now()
  expect(await backgroundLogsAwaitingNew("bg-999", 10)).toContain("لا تشغيلَ خلفيّاً")
  expect(Date.now() - t0).toBeLessThan(500)
})

test("logs is volatile in the agent loop: repeating it while a job runs is not a duplicate stop", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain("|dismiss|desk|logs)\\b/u.test(command)")
  expect(cli).toContain("okText(await backgroundLogsAwaitingNew(id,")
})
