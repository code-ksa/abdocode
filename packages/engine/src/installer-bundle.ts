/**
 * اسمُ حزمةِ التثبيت — **مشتقٌّ من إعدادِ سطح المكتب، لا مكتوبٌ بيد.**
 *
 * 🔴 العطلُ المقيس (2026-09-26): كان الاسمُ مثبَّتاً على إصدارٍ قديم (4.0.0) بينما
 * الحيُّ 4.0.67، فالبحثُ الصاعدُ عن الحزمة **لا يصادفها أبداً**، فتردّ بوّابةُ
 * `gate installer` «لا حزمةَ مبنيّة» في كلّ مرّة — نفيٌ دائمٌ يُقرأ حالةً مشروعة
 * لا عطلاً. بوّابةٌ لا تجد ما تفحصه ليست بوّابةً.
 *
 * فالاسمُ يُقرأ من `tauri.conf.json` في المجلّد المفحوص نفسِه (productName + version):
 * قيمةٌ واحدةٌ لا قيمتان تفترقان، ولا رقمَ يتقادم عند كلّ إصدار.
 *
 * وغيابُ الإعداد أو تشوّهُ حقلَيه **رفضٌ** (undefined) لا افتراضُ اسم — «الغياب
 * رفضٌ لا إذن»، فلا يُخترع مسارٌ يوهم أنّ حزمةً وُجدت أو غابت.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** مجلّدُ NSIS نسبةً إلى جذر المستودع. */
export const INSTALLER_BUNDLE_DIR = join("packages", "desktop", "src-tauri", "target", "release", "bundle", "nsis")

/** إعدادُ سطح المكتب نسبةً إلى جذر المستودع — مصدرُ الاسم والإصدار. */
export const DESKTOP_CONF_RELATIVE = join("packages", "desktop", "src-tauri", "tauri.conf.json")

export const installerNameAt = (root: string): string | undefined => {
  try {
    const conf = JSON.parse(readFileSync(join(root, DESKTOP_CONF_RELATIVE), "utf8")) as { productName?: unknown; version?: unknown }
    if (typeof conf.productName !== "string" || typeof conf.version !== "string") return undefined
    if (conf.productName.length === 0 || conf.version.length === 0) return undefined
    return `${conf.productName}_${conf.version}_x64-setup.exe`
  } catch { return undefined }
}
