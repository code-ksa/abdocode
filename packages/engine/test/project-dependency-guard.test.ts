import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dependencyAudit, dependencyCommandViolation, sourceImports, competingGroups, EQUIVALENT_FAMILIES, REQUIRED_COMPANIONS } from "../src/project-dependency-guard"

const project = (manifest: object, files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-dep-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe("dependency guard — S4", () => {
  // الحادثة الحية 2026-08-30: --force أزال 355 حزمة بينها ما يستورده المصدر.
  test("refuses blind npm audit fix --force", () => {
    const dir = project({ dependencies: {} })
    expect(dependencyCommandViolation("npm audit fix --force", dir)).toContain("قرار أعمى")
    expect(dependencyCommandViolation("npm audit fix", dir)).toBeUndefined()
  })

  test("refuses uninstalling a package the source imports", () => {
    const dir = project(
      { dependencies: { "better-sqlite3": "^13.0.0" } },
      { "app/lib/db.ts": 'import Database from "better-sqlite3"\nexport default Database' },
    )
    expect(dependencyCommandViolation("npm uninstall better-sqlite3", dir)).toContain("يستوردها الآن")
    // حذف غير المستورد مسموح — هذا طريق تنظيف الحديقة.
    expect(dependencyCommandViolation("npm uninstall prisma", dir)).toBeUndefined()
  })

  test("refuses installing an equivalent of an installed package", () => {
    const dir = project({ dependencies: { "better-sqlite3": "^13.0.0" } })
    expect(dependencyCommandViolation("npm install sql.js", dir)).toContain("مكافئ منصّب")
    expect(dependencyCommandViolation("npm install prisma@6.12.0", dir)).toContain("مكافئ منصّب")
    expect(dependencyCommandViolation("bun add bcryptjs", dir)).toBeUndefined()
    expect(dependencyCommandViolation("npm install zod", dir)).toBeUndefined()
  })

  test("hasher family is guarded like the db family", () => {
    const dir = project({ dependencies: { bcryptjs: "^3.0.0" } })
    expect(dependencyCommandViolation("npm install bcrypt", dir)).toContain("تجزئة كلمات المرور")
  })

  test("audit catches a source import missing from the manifest", () => {
    const dir = project(
      { dependencies: { next: "16.0.0" } },
      { "app/lib/db.ts": 'import Database from "better-sqlite3"' },
    )
    expect(dependencyAudit(dir)).toContain("better-sqlite3")
    expect(dependencyAudit(dir)).toContain("ليست في package.json")
  })

  test("audit names the equivalent family stacking and which member to keep", () => {
    const dir = project(
      { dependencies: { bcrypt: "^6.0.0", bcryptjs: "^3.0.0" } },
      { "app/lib/auth.ts": 'import bcrypt from "bcryptjs"' },
    )
    const verdict = dependencyAudit(dir)
    expect(verdict).toContain("تجزئة كلمات المرور")
    expect(verdict).toContain("أبقِ bcryptjs")
  })

  test("a clean project passes both the command guard and the audit", () => {
    const dir = project(
      { dependencies: { "better-sqlite3": "^13.0.0", bcryptjs: "^3.0.0", next: "16.0.0" } },
      { "app/lib/db.ts": 'import Database from "better-sqlite3"\nimport bcrypt from "bcryptjs"' },
    )
    expect(dependencyAudit(dir)).toBeUndefined()
    expect(dependencyCommandViolation("npm install zod", dir)).toBeUndefined()
    expect(dependencyCommandViolation("npm run build", dir)).toBeUndefined()
  })

  test("source import extraction handles scoped packages and skips relatives", () => {
    const dir = project({}, {
      "src/a.ts": 'import { PrismaClient } from "@prisma/client"\nimport x from "./local"\nimport y from "@/lib/db"\nimport z from "node:fs"',
    })
    const imports = sourceImports(dir)
    expect(imports.has("@prisma/client")).toBe(true)
    expect(imports.has("./local")).toBe(false)
    expect(imports.has("@/lib/db")).toBe(false)
    expect(imports.has("node:fs")).toBe(false)
  })

  // ⚠ التصحيح المقيس 2026-09-06: الزوجُ الصحيح ليس تكديساً — التوأمُ الإيجابيّ الذي كان غائباً.
  describe("الرفاقُ ليسوا متكافئات — سجلُّ المالك الحيّ", () => {
    const fixture = (manifest: object, source?: string) => {
      const dir = mkdtempSync(join(tmpdir(), "abdo-dep-pair-"))
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
      if (source !== undefined) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "db.ts"), source) }
      return dir
    }
    test("prisma (CLI) + @prisma/client (وقت التشغيل) يمرّان في التدقيق، وتثبيتُ النصف الناقص يمرّ", () => {
      const dir = fixture({ dependencies: { "@prisma/client": "^6.19.3", next: "16.0.0" }, devDependencies: { prisma: "^6.19.3" } }, 'import { PrismaClient } from "@prisma/client"')
      expect(dependencyAudit(dir)).toBeUndefined()
      expect(dependencyCommandViolation("npm run build", dir)).toBeUndefined()
      const half = fixture({ dependencies: { "@prisma/client": "^6.19.3" } })
      expect(dependencyCommandViolation("npm install -D prisma@6", half)).toBeUndefined()
      expect(dependencyCommandViolation("npm install @prisma/client", fixture({ devDependencies: { prisma: "^6.19.3" } }))).toBeUndefined()
      rmSync(dir, { recursive: true, force: true }); rmSync(half, { recursive: true, force: true })
    })
    test("drizzle-orm + drizzle-kit + سائقُها better-sqlite3 يمرّون؛ وبريزما مع محوّلها وسائقه تمرّ", () => {
      const drizzle = fixture({ dependencies: { "drizzle-orm": "^0.45.2", "better-sqlite3": "^13.0.0" }, devDependencies: { "drizzle-kit": "^0.31.10" } })
      expect(dependencyAudit(drizzle)).toBeUndefined()
      const prisma = fixture({ dependencies: { "@prisma/client": "^6.19.3", "@prisma/adapter-better-sqlite3": "^6.19.3", "better-sqlite3": "^13.0.0" }, devDependencies: { prisma: "^6.19.3" } })
      expect(dependencyAudit(prisma)).toBeUndefined()
      rmSync(drizzle, { recursive: true, force: true }); rmSync(prisma, { recursive: true, force: true })
    })
    test("التوأمُ السلبيّ ما زال يعضّ: بريزما + دريزل تكديسٌ، وتثبيتُ بديلٍ على مشروع بريزما يُرفض، وسائقٌ بلا محوّلٍ تكديس", () => {
      const both = fixture({ dependencies: { "@prisma/client": "^6.19.3", "drizzle-orm": "^0.45.2" }, devDependencies: { prisma: "^6.19.3" } }, 'import { PrismaClient } from "@prisma/client"')
      const verdict = dependencyAudit(both)
      expect(verdict).toContain("منصّبة 2 مرات")
      expect(verdict).toContain("أبقِ prisma، @prisma/client")
      expect(dependencyCommandViolation("npm install drizzle-orm", fixture({ dependencies: { "@prisma/client": "^6.19.3" }, devDependencies: { prisma: "^6.19.3" } }))).toContain("مكافئ منصّب")
      expect(dependencyAudit(fixture({ dependencies: { "@prisma/client": "^6.19.3", "better-sqlite3": "^13.0.0" } }))).toContain("منصّبة")
      rmSync(both, { recursive: true, force: true })
    })
    test("الرفاقُ الإلزاميّون في project-stack يسكنون مجموعةً واحدة هنا — المصدران لا يفترقان", () => {
      for (const [base, companions] of Object.entries(REQUIRED_COMPANIONS)) {
        const family = EQUIVALENT_FAMILIES.find((f) => f.groups.some((g) => g.members.includes(base)))!
        const group = family.groups.find((g) => g.members.includes(base))!
        for (const c of companions) expect(`${base}+${c}: ${group.members.includes(c)}`).toBe(`${base}+${c}: true`)
        expect(competingGroups(family, new Set([base, ...companions])).length).toBeLessThanOrEqual(1)
      }
    })
  })
})
