import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globalInstallRefused } from "../src/global-install-guard"

/**
 * 🔴 **الحارسُ كان يمنع الصيغةَ التي لا يكتبها أحدٌ ويُمرّر التي يكتبها الجميع.**
 *
 * النمطُ القديم طلب فراغاً قبل `-g` بعد أن استهلك الفراغَ الذي يلي `install`، فلم
 * يطابق إلا العلمَ المتأخّر. قِيس 2026-09-27 أنّ `npm install -g typescript` — الشكلُ
 * الشائع — **كان يمرّ**، وكذا `npm i -g` و`pnpm add -g` و`bun add -g` و`yarn global add`.
 * وحارسٌ يُقرأ حمايةً وهو لا يمسك الشكلَ الشائع أسوأُ من غيابه.
 */
describe("the global install guard catches the flag wherever it sits", () => {
  test("THE FORMS THAT USED TO PASS (the positive twins)", () => {
    for (const command of [
      "npm install -g typescript",
      "npm i -g typescript",
      "pnpm add -g eslint",
      "bun add -g cowsay",
      "bun install -g cowsay",
      "yarn global add typescript",
      "yarn global upgrade typescript",
    ]) {
      expect(`${command} ⇦ ${globalInstallRefused(command)}`).toBe(`${command} ⇦ true`)
    }
  })

  test("the forms it already caught still fail closed", () => {
    for (const command of ["npm install typescript -g", "npm install --global typescript", "pnpm add eslint -g"]) {
      expect(`${command} ⇦ ${globalInstallRefused(command)}`).toBe(`${command} ⇦ true`)
    }
  })

  test("THE NEGATIVE TWIN: a local install and an unrelated command are not refused", () => {
    for (const command of [
      "npm install typescript",
      "npm install",
      "bun install",
      "npm run build",
      "pnpm add -D vitest",
      "node scripts/-g.js",
      "git commit -m \"add -g to docs\"",
      "echo --global",
    ]) {
      expect(`${command} ⇦ ${globalInstallRefused(command)}`).toBe(`${command} ⇦ false`)
    }
  })

  test("the engine calls it, and no copy of the old pattern survives", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("if (globalInstallRefused(cmd)) {")
    // نمطٌ ثانٍ لنفس السؤال يفترق في أوّل تعديل — والقديمُ كان هو الثقب.
    expect(cli).not.toContain("(?:install|add|i)\\s+.*(?:\\s-g\\b")
  })
})
