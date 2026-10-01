/**
 * 10-01 — صياغةُ CSS قبل الكتابة. مقيس حيّاً: «.search-shortcut:» بلا «{» في globals.css ⇦ 500 على كلّ صفحة.
 * التوأمُ الإيجابيّ يُقاس كذلك: Tailwind 4 بتوجيهاته والتعشيشُ ومحدِّداتٌ حديثة تمرّ — حارسٌ يحجب الصحيحَ أسوأُ من غيابه.
 */
import { describe, expect, test } from "bun:test"
import { cssSourceViolation } from "../src/css-source-guard"

const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const check = (after: string, target = "src/app/globals.css") => cssSourceViolation({ normalizedTarget: target, after })

describe("css source guard", () => {
  test("the measured break is refused with its line and column", async () => {
    const broken = ".a {\n  color: red;\n}\n@media (min-width: 1280px) {\n  .search-shortcut:\n    display: inline-flex;\n  }\n}\n"
    const v = await check(broken)
    expect(v).toStartWith("صياغة CSS غير صالحة:")
    expect(v).toContain("سطر 7")
  })

  test("valid Tailwind 4 passes: @import, @theme, @utility, @apply, @custom-variant, @source, @layer", async () => {
    const tw4 = [
      '@import "tailwindcss";',
      '@source "../components";',
      "@custom-variant dark (&:where(.dark, .dark *));",
      "@theme { --color-bg: #0a0d14; --color-text-muted: #94a3b8; --font-sans: Tajawal, sans-serif; }",
      "@utility btn-base { display: inline-flex; padding: 0.5rem 1rem; }",
      "@layer base { html { color-scheme: dark; } }",
      ".card { @apply btn-base text-sm md:text-base; }",
    ].join("\n")
    expect(await check(tw4)).toBeUndefined()
  })

  test("nesting, container queries, :has, logical properties and color-mix pass", async () => {
    const modern = ".card { color: color-mix(in oklch, red 40%, blue); & .title { margin-inline-start: 1rem; } &:has(> img) { padding-block: 0; } }\n@container (min-width: 400px) { .card { inset-inline: 0; } }\n"
    expect(await check(modern)).toBeUndefined()
  })

  test("only .css files are parsed — the same broken bytes elsewhere are not this guard's business", async () => {
    const broken = "@media (min-width: 1280px) {\n  .search-shortcut:\n    display: inline-flex;\n  }\n}\n"
    expect(await check(broken)).toBeDefined()
    expect(await check(broken, "src/app/page.tsx")).toBeUndefined()
    expect(await check(broken, "styles/x.scss")).toBeUndefined()
    expect(await check(broken, "README.md")).toBeUndefined()
  })

  test("the write path refuses before the atomic writer, right after the tsx guard", () => {
    expect(cli).toContain("const invalidCss = await cssSourceViolation(identityWrite)")
    expect(cli.indexOf("const invalidCss = await cssSourceViolation(identityWrite)")).toBeGreaterThan(cli.indexOf("const invalidTsx = tsxSourceViolation(identityWrite)"))
    expect(cli).toContain("return refused(`رُفض CSS: ${invalidCss}.")
    expect(cli).toContain("if (invalidCss !== undefined) {\r\n      return refused(`رُفض CSS:")
  })
})
