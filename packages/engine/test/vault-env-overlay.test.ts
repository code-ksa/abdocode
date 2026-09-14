/**
 * إعلانُ مكان الخزنة لأبناء العملية.
 *
 * ⚠ العطلُ الذي وُلد منه هذا الملفّ قِيس على **النسخة المشحونة** لا على الشجرة
 * (2026-09-04): كلُّ مزوّدٍ سحابيّ كان يُقرأ «بلا مفتاح» لأنّ عاملَ Rust يشترط
 * `ABDO_VAULT_SCRIPT` ولا أحدَ يضبطها — ثمّ تسقط الجولةُ إلى نموذجٍ محلّيّ
 * وتُبلغ سبباً كاذباً. فالفحصُ هنا يحرس ثلاثاً: أنّ الإعلانَ يقع، وأنّ قرارَ
 * المالك لا يُدهَس، وأنّ المُعلَن **ملفٌّ موجودٌ فعلاً** لا مسارٌ متخيَّل.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OWNER_VAULT_ENV, VAULT_DIR_ENV, VAULT_HOME_ENV, vaultEnvOverlay } from "../src/vault"

const inTemp = (run: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "abdo-vault-overlay-"))
  try { run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

describe("vaultEnvOverlay — ما يرثه عاملُ المزوّدين", () => {
  test("بلا إعلانِ مالك: يُعلَن السكربتُ والجذر، والسكربتُ **موجودٌ على القرص**", () => {
    inTemp((home) => {
      const decided = vaultEnvOverlay({ [VAULT_HOME_ENV]: home })
      expect("overlay" in decided).toBe(true)
      if (!("overlay" in decided)) return
      const script = decided.overlay[OWNER_VAULT_ENV]
      expect(script).toBe(join(home, "vault.ps1"))
      expect(decided.overlay[VAULT_DIR_ENV]).toBe(join(home, "vault"))
      // التوأمُ الحاكم: إعلانُ مسارٍ لا ملفَّ عنده هو العطلُ نفسُه بثوبٍ آخر.
      expect(existsSync(script!)).toBe(true)
    })
  })

  test("خزنةُ المالك مُعلنة: لا يُضاف شيءٌ ولا يُدهَس شيء", () => {
    inTemp((home) => {
      const ownerScript = join(home, "my-vault.ps1")
      writeFileSync(ownerScript, "# خزنة المالك")
      const decided = vaultEnvOverlay({
        [VAULT_HOME_ENV]: home,
        [OWNER_VAULT_ENV]: ownerScript,
        [VAULT_DIR_ENV]: join(home, "elsewhere"),
      })
      expect("overlay" in decided).toBe(true)
      if (!("overlay" in decided)) return
      expect(Object.keys(decided.overlay)).toEqual([])
    })
  })

  test("جذرٌ مضبوطٌ من المالك يبقى، والسكربتُ وحدَه يُعلَن", () => {
    inTemp((home) => {
      const store = join(home, "مخزنٌ-مختار")
      const decided = vaultEnvOverlay({ [VAULT_HOME_ENV]: home, [VAULT_DIR_ENV]: store })
      expect("overlay" in decided).toBe(true)
      if (!("overlay" in decided)) return
      expect(Object.keys(decided.overlay).sort()).toEqual([OWNER_VAULT_ENV])
    })
  })

  test("خزنةُ مالكٍ مُعلنةٌ على ملفٍّ غائب: رفضٌ مسمّى لا ارتدادٌ صامت", () => {
    inTemp((home) => {
      const decided = vaultEnvOverlay({ [VAULT_HOME_ENV]: home, [OWNER_VAULT_ENV]: join(home, "لا-يوجد.ps1") })
      expect("refusal" in decided).toBe(true)
    })
  })

  test("بيتٌ متعذّر (لا ملفَّ مستخدم): رفضٌ لا مسارٌ نصفيّ", () => {
    const decided = vaultEnvOverlay({})
    expect("refusal" in decided).toBe(true)
  })
})
