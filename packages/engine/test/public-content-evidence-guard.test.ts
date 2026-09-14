import { describe, expect, test } from "bun:test"
import { unsupportedPublicContactClaim } from "../src/public-content-evidence-guard"

const base = {
  projectDir: "C:\\project",
  normalizedTarget: "app/page.tsx",
  operation: "write" as const,
  before: "",
}

describe("public content evidence guard", () => {
  test("rejects an invented hardcoded company address", () => {
    expect(unsupportedPublicContactClaim({ ...base, after: '<p>مقر الشركة: المنطقة الصناعية، الدار البيضاء</p>' })).toContain("مقر الشركة")
  })

  test("rejects hardcoded phone and email coordinates", () => {
    expect(unsupportedPublicContactClaim({ ...base, after: '<p>هاتف: +966 50 000 0000</p>' })).toContain("هاتف")
    expect(unsupportedPublicContactClaim({ ...base, after: '<p>info@example.com</p>' })).toContain("@")
  })

  test("allows a generic invitation to use the contact page", () => {
    expect(unsupportedPublicContactClaim({ ...base, after: '<p>تواصل معنا عبر النموذج لمناقشة احتياجك</p>' })).toBeUndefined()
  })

  test("rejects a hardcoded copyright year in a shared component", () => {
    expect(unsupportedPublicContactClaim({
      ...base,
      normalizedTarget: "app/components/site-shell.tsx",
      after: "export const Footer = () => <footer>© 2025 السعادة</footer>",
    })).toContain("2025")
  })
})
