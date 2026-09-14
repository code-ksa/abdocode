/**
 * ثغرةٌ أمنيّةٌ مقيسة (2026-09-04) — والفحصُ يسأل **العمليّةَ الوليدة نفسَها**.
 *
 * `ExternalSession` تُشغّل أمرَ مزوّدٍ **من طرفٍ ثالث**. وكانت تُشغّله بلا حقل
 * `env`، فورث `process.env` كاملاً — ومنه `ABDO_SHELL_TOKEN`، وهو ما تُصادق به
 * القشرةُ المحرّك، ومقابضُ `ABDO_VAULT_*`. أي أنّ مزوّدَ أدواتٍ خارجيّاً كان
 * يملك مفتاحَ انتحال القشرة. هذا هو «البابُ الخلفيّ» بعينه.
 *
 * **ولماذا عمليّةٌ وسيطة؟** لأنّ Bun يلتقط البيئةَ مرّةً عند الإقلاع: تعديلُ
 * `process.env` داخل الاختبار لا يبلغ طفلاً يرث. فلو ضبطنا المفتاحَ هنا، لقرأه
 * الطفلُ «غائباً» **حتى والحارسُ مُعطَّل** — أخضرُ يعني «لم يحدث شيء». فالمفتاح
 * يُوضع في بيئة عمليّةٍ وسيطة تُقلع به، ومنها تُبنى الجلسة. هكذا تحمرّ الطفرة.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const forward = (path: string): string => path.split("\\").join("/")

describe("external tool provider — the child's own environment", () => {
  test("a third-party provider process receives no shell token and no vault handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-external-env-"))
    const probe = join(dir, "probe.json")
    const provider = join(dir, "provider.mjs")
    const harness = join(dir, "harness.mjs")
    const externalModule = forward(resolve(import.meta.dir, "../src/mind/external.ts"))

    // المزوّد: يكتب ما وصله من بيئة ثمّ يصمت. لا مصافحةَ — المقيس هو البيئة.
    writeFileSync(provider, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(forward(probe))}, JSON.stringify({`,
      '  token: process.env.ABDO_SHELL_TOKEN ?? "absent",',
      '  vault: process.env.ABDO_VAULT_SCRIPT ?? "absent",',
      '  harmless: process.env.ABDO_HARMLESS_PROBE ?? "absent",',
      "}))",
      "setTimeout(() => process.exit(0), 2000)",
    ].join("\n"))

    // الوسيط: يُقلع بالبيئة الملوّثة، ومنها يبني الجلسةَ الحقيقيّة.
    writeFileSync(harness, [
      `const { ExternalSession } = await import(${JSON.stringify("file:///" + externalModule)})`,
      `new ExternalSession({ id: "probe", command: [process.execPath, ${JSON.stringify(forward(provider))}] })`,
      "setTimeout(() => process.exit(0), 3000)",
    ].join("\n"))

    const middle = Bun.spawn([process.execPath, harness], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ABDO_SHELL_TOKEN: "leaked-shell-token",
        ABDO_VAULT_SCRIPT: "C:/vault/secrets.ps1",
        ABDO_HARMLESS_PROBE: "present",
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    try {
      const deadline = Date.now() + 25_000
      while (!existsSync(probe) && Date.now() < deadline) await Bun.sleep(120)
      if (!existsSync(probe)) {
        throw new Error(`the provider never started; stderr=${(await new Response(middle.stderr).text()).slice(0, 1_200)}`)
      }
      const seen = JSON.parse(readFileSync(probe, "utf-8")) as Record<string, string>

      // المفتاحُ ومقبضُ الخزنة لا يبلغان الطرفَ الثالث.
      expect(seen.token).toBe("absent")
      expect(seen.vault).toBe("absent")
      // والتوأمُ الإيجابيّ: متغيّرٌ خارج القائمة **يصل فعلاً**. بدونه كان
      // «absent» قد يعني أنّ العمليّة لم ترث شيئاً أصلاً — أو لم تُشغَّل.
      expect(seen.harmless).toBe("present")
    } finally {
      middle.kill()
      await middle.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})
