import { describe, expect, test } from "bun:test"
import { stripChildEnv } from "@abdo/tools/env-strip"
import { OWNER_VAULT_ENV, VAULT_DIR_ENV, VAULT_HOME_ENV } from "../src/vault"

/**
 * فحصُ العبور بين حزمتين: النازعُ في `@abdo/tools`، وأسماءُ الخزنة يملكها
 * `engine/src/vault.ts`. لا تستطيع الحزمةُ الأدنى أن تستورد الأعلى (وإلا صارت
 * دورة)، فتُقاس التغطيةُ **هنا** حيث تُرى الاثنتان.
 *
 * العطلُ الذي جاء منه هذا الملفّ (وجدته مراجعةٌ عدائيّة 2026-09-03): النازعُ
 * كان يسمّي ثلاثةَ متغيّراتِ خزنةٍ **لا يضبطها المنتَج إطلاقاً**، بينما
 * الثلاثةُ الحقيقيّة تعبر إلى الابن سالمة. حارسٌ يحرس أبواباً لا وجود لها
 * ويترك الحقيقيّة مفتوحة — وهو أسوأُ من غيابه، لأنّ اسمَه يشهد بأنّ البابَ
 * مُغلق.
 *
 * والقياسُ هنا يقرأ الأسماءَ **من مالكها** لا من نسخةٍ ثانية: فمتغيّرُ خزنةٍ
 * جديدٌ يُضاف في `vault.ts` يُحمِّر هذا الفحصَ يومَ يُضاف إن لم تغطِّه القاعدة.
 */
describe("نزعُ البيئة يغطّي كلَّ ما تُسمّيه وحدةُ الخزنة", () => {
  test("كلُّ متغيّرِ خزنةٍ يملكه المحرّك لا يصل الابن", () => {
    const owned = [OWNER_VAULT_ENV, VAULT_DIR_ENV, VAULT_HOME_ENV]
    // التوأمُ الإيجابي: الأسماءُ حقيقيّةٌ وغيرُ فارغة — وإلا قاس هذا الفحصُ العدم.
    expect(owned.every((name) => typeof name === "string" && name.length > 0)).toBe(true)
    expect(new Set(owned).size).toBe(3)

    const source: Record<string, string> = { PATH: "p" }
    for (const name of owned) source[name] = "sensitive"
    const { env, stripped } = stripChildEnv(source)

    for (const name of owned) {
      expect(`${name} reaches child = ${name in env}`).toBe(`${name} reaches child = false`)
      expect(stripped).toContain(name)
    }
    // وما ليس خزنةً يعبر — الحارسُ ليس ساتراً.
    expect(env["PATH"]).toBe("p")
  })

  test("ولا تُمرَّر بطلبٍ صريح: الخزنةُ ليست خياراً للمُنادي", () => {
    const source = Object.fromEntries([OWNER_VAULT_ENV, VAULT_DIR_ENV, VAULT_HOME_ENV].map((n) => [n, "x"]))
    const { env } = stripChildEnv(source, { pass: [OWNER_VAULT_ENV, VAULT_DIR_ENV, VAULT_HOME_ENV] })
    expect(Object.keys(env)).toEqual([])
  })
})
