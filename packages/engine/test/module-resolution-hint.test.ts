import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { moduleResolutionHints } from "../src/module-resolution-hint"

const project = (tsconfig: object | undefined, files: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-mrh-"))
  if (tsconfig !== undefined) writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig))
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), "export default {}")
  }
  return dir
}

const failed = (spec: string) => `Module not found: Can't resolve '${spec}'\n> 3 | import db from "${spec}";`

describe("module resolution hints — S6", () => {
  // الحالة الحية: paths محذوفة كلياً والمستورد بامتداد وبلا alias.
  test("names the exact fix when tsconfig has no paths at all", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    const hint = moduleResolutionHints(failed("app/lib/db.ts"), dir)
    expect(hint).toContain("لا تكتب الامتداد")
    expect(hint).toContain("app/lib/db.ts")
    expect(hint).toContain('"paths": {"@/*": ["./*"]}')
    expect(hint).toContain("بلا baseUrl")
  })

  test("computes the correct alias specifier from the declared paths", () => {
    const dir = project({ compilerOptions: { paths: { "@/*": ["./*"] } } }, ["app/lib/db.ts"])
    const hint = moduleResolutionHints(failed("@/lib/db"), dir)
    expect(hint).toContain("الملف الفعلي app/lib/db.ts")
    expect(hint).toContain("'@/app/lib/db'")
  })

  test("says so plainly when no file with that name exists", () => {
    const dir = project({ compilerOptions: { paths: { "@/*": ["./*"] } } }, ["app/page.tsx"])
    expect(moduleResolutionHints(failed("@/lib/ghost"), dir)).toContain("لا ملف بهذا الاسم")
  })

  // حزمة npm غائبة شأنُ حارس التبعيات لا شأن المسارات — لا ضوضاء مزدوجة.
  test("stays silent for missing npm packages and for clean output", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    expect(moduleResolutionHints(failed("better-sqlite3"), dir)).toBe("")
    expect(moduleResolutionHints("✓ Compiled successfully in 300ms", dir)).toBe("")
  })

  test("tolerates a tsconfig with comments and trailing commas", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-mrh-jsonc-"))
    writeFileSync(join(dir, "tsconfig.json"), '{\n // تعليق\n "compilerOptions": { "paths": { "@/*": ["./*"], } },\n}')
    mkdirSync(join(dir, "app"), { recursive: true })
    writeFileSync(join(dir, "app", "db.ts"), "export {}")
    expect(moduleResolutionHints(failed("@/db"), dir)).toContain("'@/app/db'")
  })

  // الكتيّب الثاني — الحادثة الحية: better-sqlite3 حُزمت لكود المتصفح.
  test("diagnoses a native node module bundled for the browser", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    const output = "./node_modules/better-sqlite3/lib/database.js:2:12\nError: Module not found: Can't resolve 'fs'"
    const hint = moduleResolutionHints(output, dir)
    expect(hint).toContain("better-sqlite3")
    expect(hint).toContain("serverExternalPackages: ['better-sqlite3']")
    expect(hint).toContain('"use client"')
  })

  test("when serverExternalPackages already names the package, points at use client instead", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    writeFileSync(join(dir, "next.config.ts"), "export default { serverExternalPackages: ['better-sqlite3'] }")
    const output = "./node_modules/better-sqlite3/lib/database.js:2:12\nError: Module not found: Can't resolve 'fs'"
    const hint = moduleResolutionHints(output, dir)
    expect(hint).toContain("فعلاً")
    expect(hint).toContain("Server Components")
  })

  test("a project-source fs failure is not misread as a native-module case", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    const hint = moduleResolutionHints("./app/lib/db.ts:1:1\nError: Module not found: Can't resolve 'fs'", dir)
    expect(hint).not.toContain("serverExternalPackages")
  })

  // الكتيّب الثالث — الحادثة الحية: مسار API أسقط جمع بيانات الصفحات.
  test("diagnoses module-import-time db access behind failed page data collection", () => {
    const dir = project({ compilerOptions: {} }, ["app/lib/db.ts"])
    const hint = moduleResolutionHints("> Build error occurred\nError: Failed to collect page data for /api/admin/services", dir)
    expect(hint).toContain("/api/admin/services")
    expect(hint).toContain("وقتَ استيراد الوحدة")
    expect(hint).toContain('export const dynamic = "force-dynamic"')
  })

  // Live escape (noor): a test used ../../app/lib/auth (wrong depth). The
  // alias may not resolve under vitest, so a test file gets the correct
  // relative path computed from its own location.
  test("computes the correct relative path for a test file's wrong-depth import", () => {
    const dir = project({ compilerOptions: { paths: { "@/*": ["./*"] } } }, ["app/lib/auth.ts"])
    const out = "tests/auth.test.ts(2,43): error TS2307: Cannot find module '../../app/lib/auth' or its corresponding type declarations."
    const hint = moduleResolutionHints(out, dir)
    expect(hint).toContain("../app/lib/auth")
    expect(hint).toContain("vitest")
  })

  test("caps the number of diagnosed specifiers", () => {
    const dir = project({ compilerOptions: {} }, ["app/a.ts"])
    const output = Array.from({ length: 12 }, (_, i) => failed(`@/x${i}`)).join("\n")
    const lines = moduleResolutionHints(output, dir).split("\n").filter((line) => line.startsWith("«"))
    expect(lines.length).toBeLessThanOrEqual(6)
  })
})
