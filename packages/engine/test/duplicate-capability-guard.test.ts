import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { duplicateCapabilityViolation } from "../src/duplicate-capability-guard"

const project = (files: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-dup-"))
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true })
    writeFileSync(join(dir, f), "export default {}")
  }
  return dir
}

describe("duplicate capability guard — S3", () => {
  // الحادثة الحية: db.ts موجود في app/lib، النموذج يخلق lib/db.ts.
  test("refuses a second copy of an existing named capability", () => {
    const dir = project(["app/lib/db.ts"])
    const v = duplicateCapabilityViolation({ normalizedTarget: "lib/db.ts", existsAlready: false }, dir)
    expect(v).toContain("نسخة ثانية")
    expect(v).toContain("app/lib/db.ts")
  })

  test("allows editing the existing file itself", () => {
    const dir = project(["app/lib/db.ts"])
    expect(duplicateCapabilityViolation({ normalizedTarget: "app/lib/db.ts", existsAlready: true }, dir)).toBeUndefined()
  })

  test("allows a genuinely new capability name", () => {
    const dir = project(["app/lib/db.ts"])
    expect(duplicateCapabilityViolation({ normalizedTarget: "app/lib/mailer.ts", existsAlready: false }, dir)).toBeUndefined()
  })

  test("does not flag structural names that legitimately repeat", () => {
    const dir = project(["app/services/page.tsx", "app/projects/route.ts"])
    expect(duplicateCapabilityViolation({ normalizedTarget: "app/contact/page.tsx", existsAlready: false }, dir)).toBeUndefined()
    expect(duplicateCapabilityViolation({ normalizedTarget: "app/about/route.ts", existsAlready: false }, dir)).toBeUndefined()
  })
})
