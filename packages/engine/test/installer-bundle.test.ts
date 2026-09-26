import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DESKTOP_CONF_RELATIVE, INSTALLER_BUNDLE_DIR, installerNameAt } from "../src/installer-bundle"

/**
 * 🔴 **بوّابةٌ لا تجد ما تفحصه تقول «لا حزمةَ مبنيّة» إلى الأبد — وهذا نفيٌ لا حكم.**
 *
 * كان اسمُ المُنصِّب مكتوباً بيدٍ على إصدارٍ قديم (4.0.0) بينما الحيُّ 4.0.67، فبحثُ
 * `gate installer` الصاعدُ لا يصادف الحزمةَ أبداً، فيردّ نفياً يُقرأ حالةً مشروعة.
 * الاسمُ الآن يُشتقّ من `tauri.conf.json` في المجلّد المفحوص نفسِه.
 */
const tree = (conf: unknown | undefined): string => {
  const root = mkdtempSync(join(tmpdir(), "abdo-installer-"))
  mkdirSync(join(root, INSTALLER_BUNDLE_DIR), { recursive: true })
  if (conf !== undefined) {
    mkdirSync(join(root, DESKTOP_CONF_RELATIVE, ".."), { recursive: true })
    writeFileSync(join(root, DESKTOP_CONF_RELATIVE), typeof conf === "string" ? conf : JSON.stringify(conf))
  }
  return root
}

describe("the installer name follows the desktop config, so it cannot go stale", () => {
  const trees: string[] = []
  const make = (conf: unknown | undefined): string => { const root = tree(conf); trees.push(root); return root }

  test("THE MEASURED CASE (the positive twin): the name carries the config's own version", () => {
    const root = make({ productName: "AbdoCode", version: "4.0.67", identifier: "io.abdocode.desktop" })
    expect(installerNameAt(root)).toBe("AbdoCode_4.0.67_x64-setup.exe")
    // وإصدارٌ جديدٌ غداً يتبع بلا لمسِ شيفرة — وهذا كلُّ الغرض.
    const next = make({ productName: "AbdoCode", version: "4.1.0" })
    expect(installerNameAt(next)).toBe("AbdoCode_4.1.0_x64-setup.exe")
  })

  test("absence and malformation are refusals, not an invented name", () => {
    expect(installerNameAt(make(undefined))).toBeUndefined()
    expect(installerNameAt(make("{ not json"))).toBeUndefined()
    expect(installerNameAt(make({ version: "4.0.67" }))).toBeUndefined()
    expect(installerNameAt(make({ productName: "AbdoCode" }))).toBeUndefined()
    expect(installerNameAt(make({ productName: "", version: "4.0.67" }))).toBeUndefined()
    expect(installerNameAt(make({ productName: "AbdoCode", version: 4.067 }))).toBeUndefined()
    expect(installerNameAt(join(tmpdir(), "abdo-no-such-tree-" + Date.now()))).toBeUndefined()
  })

  test("the two places that hold the desktop version agree", () => {
    // 🔴 قِيس 2026-09-27: `tauri.conf.json` على 4.0.67 و`package.json` على 4.0.55 — انحرافُ
    // اثنتَي عشرةَ نسخة. والقفلُ يقرأ الثانيَ، فكان `bun.lock` يحمل رقماً لا وجودَ له.
    // مصدرُ الإصدار للبنية هو إعدادُ tauri، وهذا الفحصُ يمنع الثاني من الانزلاق عنه.
    const repo = join(import.meta.dir, "..", "..", "..")
    const conf = JSON.parse(readFileSync(join(repo, DESKTOP_CONF_RELATIVE), "utf8")) as { version: string }
    const pkg = JSON.parse(readFileSync(join(repo, "packages", "desktop", "package.json"), "utf8")) as { version: string }
    expect(`${pkg.version} == ${conf.version}`).toBe(`${conf.version} == ${conf.version}`)
  })

  test("the live repo config is readable and names this product", () => {
    // قياسٌ على الشجرة الحقيقيّة: لو تشوّه الإعدادُ لصار «لا حزمةَ مبنيّة» صامتاً من جديد.
    const repo = join(import.meta.dir, "..", "..", "..")
    const name = installerNameAt(repo)
    expect(name).toBeDefined()
    expect(name!.startsWith("AbdoCode_")).toBe(true)
    expect(name!.endsWith("_x64-setup.exe")).toBe(true)
  })

  afterAll(() => {
    for (const root of trees) { try { rmSync(root, { recursive: true, force: true }) } catch { /* مؤقّت */ } }
  })
})
