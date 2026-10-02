import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tailwindApplyViolation } from "../src/tailwind-apply-guard"

// 10-02 — measured: `.card-hover { … }` then `@apply … card-hover;` in a Tailwind 4 globals.css made every page a 500
// ("Cannot apply unknown utility class"); the model removed the stylesheet import to hide it and shipped an unstyled site.
// Scanned before shipping: 13 Tailwind 4 stylesheets on this machine, only the broken one is flagged.

const project = (tailwind: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-tw-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { tailwindcss: tailwind } }))
  return dir
}
const BROKEN = `@import "tailwindcss";\n\n@layer components {\n  .card-hover {\n    transition: transform .2s;\n  }\n  .model-card {\n    @apply p-4 rounded-xl card-hover;\n  }\n}\n`

describe("Tailwind 4 @apply of a plain class", () => {
  test("is caught with its line and the fix (@utility)", () => {
    const dir = project("^4.0.0")
    try {
      const v = tailwindApplyViolation(dir, "src/app/globals.css", BROKEN)!
      expect(v).toContain("«@apply … card-hover» (سطر 8)")
      expect(v).toContain("@utility card-hover { … }")
      // a variant prefix and an !important marker still point at the same class
      expect(tailwindApplyViolation(dir, "a.css", BROKEN.replace("card-hover;", "hover:card-hover!;"))).toContain("card-hover")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("twins: defined with @utility, only built-in utilities, a commented-out rule, Tailwind 3, a non-CSS file", () => {
    const v4 = project("^4.1.0"), v3 = project("^3.4.17")
    try {
      expect(tailwindApplyViolation(v4, "g.css", BROKEN.replace(".card-hover {", "@utility card-hover {").replace("@layer components {\n  @utility", "@utility").replace(/\n}\n$/, "\n"))).toBeUndefined()
      expect(tailwindApplyViolation(v4, "g.css", "@import \"tailwindcss\";\n.btn { @apply px-4 py-2 rounded-md hover:bg-blue-600; }\n")).toBeUndefined()
      expect(tailwindApplyViolation(v4, "g.css", BROKEN.replace("@apply p-4 rounded-xl card-hover;", "/* @apply card-hover; */ @apply p-4;"))).toBeUndefined()
      expect(tailwindApplyViolation(v3, "g.css", BROKEN)).toBeUndefined()
      expect(tailwindApplyViolation(v4, "layout.tsx", BROKEN)).toBeUndefined()
    } finally { rmSync(v4, { recursive: true, force: true }); rmSync(v3, { recursive: true, force: true }) }
  })
  test("cli refuses the write and warns on read", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    expect(cli).toContain("const twApply = invalidCss === undefined ? tailwindApplyViolation(PROJECT_DIR, normalizedTarget, after) : undefined")
    expect(cli).toContain("return refused(`رُفض CSS: ${twApply} — لم يُكتب شيء.`)")
    expect(cli).toContain("(twApplyNote === undefined ? \"\" : `\\n\\n⚠ ${twApplyNote}`)")
  })
})
