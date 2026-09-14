import { describe, expect, test } from "bun:test"
import { excessiveMetadataDescription } from "../src/public-content-quality-guard"

describe("public content quality guard", () => {
  test("rejects a runaway metadata description", () => {
    expect(excessiveMetadataDescription({ normalizedTarget: "app/layout.tsx", after: `export const metadata = { description: "${"ترميم وتكييف وكهرباء ".repeat(40)}" }` })).toBeGreaterThan(500)
  })

  test("allows a concise useful description", () => {
    expect(excessiveMetadataDescription({ normalizedTarget: "app/layout.tsx", after: 'export const metadata = { description: "خدمات مقاولات وإنشاء وترميم موثوقة." }' })).toBeUndefined()
  })
})
