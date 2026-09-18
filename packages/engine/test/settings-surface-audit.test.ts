/**
 * يجب أن يظهر باسمه في واجهة سطح المكتب (صفٌّ أو حقلٌ يكتبه). مفتاحٌ بلا موضعٍ في الواجهة = إعدادٌ موصولٌ بلا شيء.
 * الاستثناءاتُ المُعلنة: مفاتيحُ تُكتب من مسارٍ غيرِ الإعدادات (المشروعُ من project-create، المراجعةُ من المحرّك).
 */
import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"

const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const uiDir = new URL("../../desktop/ui/", import.meta.url)
const uiText = readdirSync(uiDir).filter((f) => /\.(js|html)$/u.test(f)).map((f) => require("node:fs").readFileSync(new URL(f, uiDir), "utf8")).join("\n")

const WRITTEN_ELSEWHERE = new Set(["project", "plugins", "theme", "panelDocks", "modelRole"])

describe("م8 — every engine settings key has a home in the desktop UI", () => {
  test("SETTINGS_KEYS ⊆ keys referenced by the shell (except the declared exceptions)", () => {
    const m = /const SETTINGS_KEYS = new Set<keyof Settings>\(\[([^\]]+)\]\)/u.exec(cli)
    expect(m).not.toBeNull()
    const keys = [...m![1]!.matchAll(/"([A-Za-z]+)"/gu)].map((x) => x[1]!)
    expect(keys.length).toBeGreaterThan(20)
    const missing = keys.filter((k) => !WRITTEN_ELSEWHERE.has(k) && !uiText.includes(k))
    expect(missing).toEqual([])
  })
})
