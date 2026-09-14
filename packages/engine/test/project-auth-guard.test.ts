import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectAuthAudit, projectAuthViolation } from "../src/project-auth-guard"

describe("generated authentication guard", () => {
  test("a resumed project cannot bypass the guard with previously written source", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "abdo-auth-"))
    mkdirSync(join(projectDir, "app", "lib"), { recursive: true })
    writeFileSync(join(projectDir, "app", "lib", "db.ts"), 'return password === "fixture-only-password"')
    expect(projectAuthAudit(projectDir)).toContain("app/lib/db.ts")
    writeFileSync(join(projectDir, "app", "lib", "db.ts"), 'export const verifyPassword = () => false')
    expect(projectAuthAudit(projectDir)).toBeUndefined()
  })

  test("rejects the literal password comparison observed in the Qwen database module", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/db.ts", after: 'function verifyPassword(password: string) { return password === "fixture-only-password" }' })).toContain("كلمة مرور ثابتة")
  })

  test("rejects a reversed comparison and a hardcoded environment fallback", () => {
    for (const after of ['return "fixture-only-password" == password', 'const pw = process.env.ADMIN_PASSWORD || "fixture-only-password"']) {
      expect(projectAuthViolation({ normalizedTarget: "app/api/login/route.ts", after })).toBeDefined()
    }
  })

  test("allows empty-input rejection and a required environment value without a fallback", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/auth.ts", after: 'if (password === "") return false; const hash = process.env.ADMIN_PASSWORD_HASH; if (!hash) return false; return verifyHash(password, hash);' })).toBeUndefined()
  })

  test("does not mistake documentation for executable authentication", () => {
    expect(projectAuthViolation({ normalizedTarget: "README.md", after: 'Never use password === "fixture-only-password"' })).toBeUndefined()
  })

  // Live escape 2026-08-30: after the model replaced plaintext storage with
  // bcrypt it seeded the bootstrap admin from a constant, and the comparison
  // and fallback rules both passed it.
  test("rejects a hardcoded credential handed to a password hasher", () => {
    const after = 'const encryptedPassword = hashPassword("fixture-only-seed")\ndb.prepare("INSERT INTO admins (password_hash, is_active) VALUES (?, ?)").run(encryptedPassword, 1)'
    expect(projectAuthViolation({ normalizedTarget: "app/lib/db.ts", after })).toContain("كلمة مرور ثابتة")
  })

  test("rejects a literal passed straight to a key-derivation API", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/db.ts", after: 'bcrypt.hashSync("fixture-only-seed", 10)' })).toBeDefined()
  })

  test("rejects a named default credential even when nothing reads it yet", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/seed.ts", after: 'const DEFAULT_ADMIN_PASSWORD = "fixture-only-seed"' })).toBeDefined()
  })

  test("allows hashing a required environment value and naming the variable", () => {
    for (const after of [
      'const secret = process.env.ADMIN_PASSWORD; if (!secret) throw new Error("missing"); const hash = hashPassword(secret)',
      'const secret = requirePassword("ADMIN_PASSWORD")',
      'const digest = createHash("sha256").update(input).digest("hex")',
    ]) {
      expect(projectAuthViolation({ normalizedTarget: "app/lib/db.ts", after })).toBeUndefined()
    }
  })

  test("does not block test fixtures that hash a constant", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/db.test.ts", after: 'const hash = hashPassword("fixture-only-seed")' })).toBeUndefined()
  })

  // Live escape 2026-08-30 (noor-clinic): a hardcoded/fallback JWT signing
  // secret survived the PASSWORD-only rules. A signing secret is a hole
  // regardless of its entropy — it signs production sessions.
  test("rejects a hardcoded signing secret and an env fallback for one", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/admin/page.tsx", after: "const JWT_SECRET = 'your-secret-key'" })).toContain("التوقيع")
    expect(projectAuthViolation({ normalizedTarget: "app/api/auth/route.ts", after: "const s = process.env.JWT_SECRET || 'your-secret-key'" })).toContain("التوقيع")
    expect(projectAuthViolation({ normalizedTarget: "app/lib/session.ts", after: "const SESSION_SECRET = 'abc123def'" })).toBeDefined()
  })

  test("allows a required signing secret with no fallback, and exempts tests", () => {
    expect(projectAuthViolation({ normalizedTarget: "app/lib/jwt.ts", after: "const JWT_SECRET = process.env.JWT_SECRET; if (!JWT_SECRET) throw new Error('missing')" })).toBeUndefined()
    expect(projectAuthViolation({ normalizedTarget: "app/lib/jwt.test.ts", after: "const JWT_SECRET = 'test-signing-key'" })).toBeUndefined()
  })
})
