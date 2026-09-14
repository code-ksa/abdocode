/**
 * خادمُ جِت — يُهاجَم، ويُقاس على مستودعٍ حيٍّ يُنشأ في اللحظة.
 *
 * وأثقلُ ما فيه أنّ «قراءةَ» مستودعٍ غريب ليست بريئة: **إعدادُه يستطيع تشغيل
 * برامج** (`diff.external`, `core.pager`, `core.fsmonitor`). فالفحصُ الحاكم
 * يزرع إعداداً خبيثاً في مستودعٍ حقيقيّ ويثبت أنّه **لم يُنفَّذ** — والتوأمُ
 * الإيجابيّ: أنّ الأمرَ نفسَه يعمل ويعيد بيانات، فالسكوتُ ليس «لم يحدث شيء».
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitArgsFor, gitEnv, NEUTRALISED_CONFIG, READ_COMMANDS, runGit, safeArgument } from "../src/mcp-servers/git"

const HAVE_GIT = Bun.which("git") !== null

const seed = async (dir: string): Promise<void> => {
  await sh(dir, ["init", "-q", "-b", "main"])
  await sh(dir, ["config", "user.email", "probe@example.com"])
  await sh(dir, ["config", "user.name", "probe"])
  writeFileSync(join(dir, "a.txt"), "one")
  await sh(dir, ["add", "."])
  await sh(dir, ["commit", "-q", "-m", "s1"])
  writeFileSync(join(dir, "a.txt"), "two")
  await sh(dir, ["add", "."])
  await sh(dir, ["commit", "-q", "-m", "s2"])
}

const sh = async (cwd: string, args: string[]): Promise<number> => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  return child.exited
}

describe("وسائطُ جِت — حقنُ الخيارات مسدود", () => {
  test("وسيطٌ يبدأ بشرطةٍ يُرفض — أشهرُ حِيَل الحقن في أدوات سطر الأمر", () => {
    for (const evil of ["--upload-pack=calc", "-c", "--output=/tmp/x", "--exec=sh"]) {
      const verdict = safeArgument(evil, "المرجع")
      expect(`${evil}: ${verdict.ok}`).toBe(`${evil}: false`)
    }
    // والمشروعُ يمرّ.
    expect(safeArgument("HEAD~3", "المرجع").ok).toBe(true)
    expect(safeArgument("feature/a-b", "المرجع").ok).toBe(true)
  })

  test("مسارٌ فيه «..» يُرفض، ومحرفُ التحكّم يُرفض، والفراغُ والطولُ كذلك", () => {
    expect(safeArgument("../../etc/passwd", "مسار الملفّ").ok).toBe(false)
    expect(safeArgument(`a${String.fromCharCode(0)}b`, "المرجع").ok).toBe(false)
    expect(safeArgument("", "المرجع").ok).toBe(false)
    expect(safeArgument("x".repeat(401), "المرجع").ok).toBe(false)
  })

  test("كلُّ أداةٍ تُترجَم إلى أمرٍ من القائمة المغلقة، والمجهولُ يُرفض", () => {
    for (const [name, args] of [
      ["log", {}], ["show", { ref: "HEAD" }], ["diff", { from: "HEAD~1" }],
      ["file", { ref: "HEAD", path: "a.txt" }], ["branches", {}],
    ] as const) {
      const planned = gitArgsFor(name, args as Record<string, unknown>)
      expect(`${name}: ${planned.ok}`).toBe(`${name}: true`)
      if (planned.ok) expect(READ_COMMANDS).toContain(planned.args[0]!)
    }
    expect(gitArgsFor("push", {}).ok).toBe(false)
    expect(gitArgsFor("fetch", {}).ok).toBe(false)
    // والسقفُ يُطبَّق: طلبُ ألفٍ يعود مئةً.
    const big = gitArgsFor("log", { limit: 1000 })
    expect(big.ok && big.args.includes("-100")).toBe(true)
  })

  test("البيئةُ تقطع إعدادَي النظام والمستخدم ولا تحمل مفتاحَ القشرة", () => {
    const env = gitEnv({ ...process.env, ABDO_SHELL_TOKEN: "leak", ABDO_VAULT_HOME: "x", KEEP: "yes" })
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env.GIT_CONFIG_GLOBAL === undefined).toBe(false)
    expect(env.ABDO_SHELL_TOKEN).toBeUndefined()
    expect(env.ABDO_VAULT_HOME).toBeUndefined()
    // والتوأمُ الإيجابيّ: ما ليس مجرَّداً يمرّ.
    expect(env.KEEP).toBe("yes")
  })
})

if (HAVE_GIT) describe("على مستودعٍ حيّ — والإعدادُ الخبيثُ لا يُنفَّذ", () => {
  test("يقرأ السجلَّ والفروعَ والملفّ، ويرفض ما ليس في القائمة", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-git-mcp-"))
    try {
      expect(await sh(dir, ["init", "-q", "-b", "main"])).toBe(0)
      await sh(dir, ["config", "user.email", "probe@example.com"])
      await sh(dir, ["config", "user.name", "probe"])
      writeFileSync(join(dir, "a.txt"), "أوّل\n")
      await sh(dir, ["add", "."])
      expect(await sh(dir, ["commit", "-q", "-m", "أوّلُ إيداع"])).toBe(0)

      const log = await runGit(dir, (gitArgsFor("log", { limit: 5 }) as { args: string[] }).args)
      expect(`${log.ok}: ${log.text.includes("أوّلُ إيداع")}`).toBe("true: true")

      const branches = await runGit(dir, (gitArgsFor("branches", {}) as { args: string[] }).args)
      expect(branches.ok && branches.text.includes("main")).toBe(true)

      const file = await runGit(dir, (gitArgsFor("file", { ref: "HEAD", path: "a.txt" }) as { args: string[] }).args)
      expect(file.ok && file.text.includes("أوّل")).toBe(true)

      // ملفٌّ لا وجودَ له: خطأٌ من جِت يصل بنصّه، لا نجاحٌ صامت.
      const missing = await runGit(dir, (gitArgsFor("file", { ref: "HEAD", path: "لا-يوجد.txt" }) as { args: string[] }).args)
      expect(missing.ok).toBe(false)

      // أمرٌ خارج القائمة يُرفض في `runGit` نفسِه ولو مُرِّر رأساً.
      const forbidden = await runGit(dir, ["push", "origin", "main"])
      expect(forbidden.ok).toBe(false)
      expect(forbidden.text).toContain("غيرُ مسموح")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * ⚠ الفحصُ الأوّلُ هنا كان **فارغاً** وأمسكته الطفرة: جرّبتُ `core.pager`،
   * وجِت لا يشغّل الصفحةَ حين يكون الخرجُ أنبوباً — فنزعُ التحييد لم يُغيّر
   * شيئاً. فقيست المفاتيحُ الخمسةُ واحداً واحداً، والمُنفَّذُ منها ثلاثة:
   * `diff.external` و`core.fsmonitor` و`textconv`. وهذه تُقاس، لا تلك.
   */
  test("⚠ مفتاحٌ يُنفَّذ فعلاً: core.fsmonitor على status — يُحيَّد", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-git-fsm-"))
    const marker = join(dir, "pwned.txt")
    try {
      await seed(dir)
      await sh(dir, ["config", "core.fsmonitor", `sh -c 'echo x > ${marker.split("\\").join("/")}'`])
      const out = await runGit(dir, ["status", "--short"])
      expect(out.ok).toBe(true)
      // لم يُنفَّذ — والطفرةُ (نزعُ التحييد) تُحمِّر هذا السطر.
      expect(existsSync(marker)).toBe(false)
      expect(NEUTRALISED_CONFIG).toContain("core.fsmonitor=")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("⚠ ومحوّلُ النصّ في .gitattributes يُنفَّذ أيضاً — يسدّه --no-textconv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-git-tc-"))
    const marker = join(dir, "pwned.txt")
    try {
      await seed(dir)
      writeFileSync(join(dir, ".gitattributes"), "* diff=evil")
      await sh(dir, ["add", "."])
      await sh(dir, ["commit", "-q", "-m", "attrs"])
      await sh(dir, ["config", "diff.evil.textconv", `sh -c 'echo x > ${marker.split("\\").join("/")}'`])
      const planned = gitArgsFor("diff", { from: "HEAD~1", to: "HEAD" })
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      // ‏`--no-textconv` حاضرةٌ في الأمر المبنيّ لا في النيّة.
      expect(planned.args).toContain("--no-textconv")
      const out = await runGit(dir, planned.args)
      expect(out.ok).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

if (!HAVE_GIT) describe("على مستودعٍ حيّ — متعذّر", () => {
  test("لا جِت على هذا الجهاز، فالفحصُ الحيُّ لا يُدّعى", () => {
    expect(HAVE_GIT).toBe(false)
  })
})
