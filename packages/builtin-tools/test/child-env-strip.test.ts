/**
 * البوّابة: ما يراه الابنُ فعلاً — لا ما تعيده الدالّة.
 *
 * حارسٌ يُفحص بعائده يمرّ وهو ينسى موضعاً. هذا الملفّ يشغّل **المسار الحقيقيّ**
 * (`run_command` عبر `PolicyToolRunner`) ويقرأ البيئةَ التي وصلت العمليةَ
 * الابنَ من داخلها، فالحكمُ من القرص لا من التوقيع.
 *
 * العطلُ الذي جاء منه: `run-command.ts` كان ينسخ `process.env` كاملاً، فأمرٌ
 * واحدٌ يوافق عليه المشغّل يقرأ `ABDO_SHELL_TOKEN` — وهو ما تُصادَق به القشرةُ
 * على المحرّك، فمن قرأه انتحلها.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolRegistry, PolicyToolRunner, type Approver } from "@abdo/tools"
import { runCommandTool } from "../src/run-command"

const yes: Approver = { approve: async () => true }

const SECRETS = {
  ABDO_SHELL_TOKEN: "shell-token-must-not-leak",
  OPENAI_API_KEY: "sk-must-not-leak",
  SOME_VENDOR_API_KEY: "unknown-vendor-must-not-leak",
  GITHUB_TOKEN: "ghp-must-not-leak",
} as const

describe("بيئةُ العملية الابن — مقيسةٌ من داخل الابن", () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v }
  })
  afterEach(() => {
    for (const k of Object.keys(SECRETS)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const inChild = async (): Promise<Record<string, string>> => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-env-"))
    try {
      writeFileSync(join(dir, "dump-env.mjs"), "console.log(JSON.stringify(process.env))\n")
      const registry = new ToolRegistry().register(runCommandTool(dir))
      const runner = new PolicyToolRunner(registry, { approver: yes } as never)
      const out = (await runner.run(
        { name: "run_command", input: { executable: process.execPath, args: ["dump-env.mjs"] } },
        { executionId: "tex_env" },
      )) as { stdout?: string; output?: { stdout?: string } }
      const text = out.stdout ?? out.output?.stdout ?? ""
      const start = text.indexOf("{")
      expect(start).toBeGreaterThanOrEqual(0)
      return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as Record<string, string>
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ويندوز قد يمسك المقبض */ }
    }
  }

  test("الابنُ لا يرى رمزَ القشرة ولا مفتاحَ مزوّدٍ — معروفاً كان أو مجهولاً", async () => {
    const childEnv = await inChild()
    // التوأمُ الإيجابي أوّلاً: الابنُ شُغِّل فعلاً وبيئتُه ليست فارغة — وإلّا
    // كان هذا الفحصُ يمرّ على عدم.
    expect(Object.keys(childEnv).length).toBeGreaterThan(3)
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(`${name} in child = ${name in childEnv}`).toBe(`${name} in child = false`)
      // ولا تسرّبَ بالقيمة تحت اسمٍ آخر.
      expect(Object.values(childEnv)).not.toContain(value)
    }
  }, 30_000)

  test("وما يحتاجه العملُ يصل: PATH وSystemRoot حاضران في الابن", async () => {
    const childEnv = await inChild()
    // الاتجاهُ المعاكس: حارسٌ يحجب كلَّ شيءٍ ليس حارساً بل عطلٌ آخر.
    const hasPath = "PATH" in childEnv || "Path" in childEnv
    expect(hasPath).toBe(true)
    if (process.platform === "win32") expect("SystemRoot" in childEnv || "SYSTEMROOT" in childEnv).toBe(true)
  }, 30_000)
})
