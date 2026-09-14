import { describe, expect, test } from "bun:test"
import { STACK_GUIDES, describeStackGuide, stackGuideFor } from "../src/stack-guides"

describe("mobile/native stacks the catalogue cannot ship get an exact guide; unknown queries get nothing", () => {
  test("Arabic and English aliases resolve to the same guide", () => {
    expect(stackGuideFor("flutter app")?.stack).toBe("flutter")
    expect(stackGuideFor("اعمل مشروع فلاتر")?.stack).toBe("flutter")
    expect(stackGuideFor("react native store")?.stack).toBe("react-native")
    expect(stackGuideFor("تطبيق رياكت نيتيف")?.stack).toBe("react-native")
    expect(stackGuideFor("swiftui")?.stack).toBe("swift")
    expect(stackGuideFor("vite")?.stack).toBe("vite-react")
    expect(stackGuideFor("next sqlite prisma")?.stack).toBe("next")
  })
  test("twin: a database-only query and an empty one resolve to no guide", () => {
    expect(stackGuideFor("postgres drizzle")).toBeUndefined()
    expect(stackGuideFor("   ")).toBeUndefined()
  })
  test("every guide has doctor → scaffold → verify → run, and the description keeps that order", () => {
    for (const g of STACK_GUIDES) {
      expect(g.doctor.length).toBeGreaterThan(0)
      expect(g.verify.length).toBeGreaterThan(0)
      const text = describeStackGuide(g)
      expect(text.indexOf(g.doctor)).toBeLessThan(text.indexOf(g.scaffold))
      expect(text.indexOf(g.scaffold)).toBeLessThan(text.indexOf(g.verify[0]!))
      expect(text).toContain("run --bg " + g.run)
    }
  })
})
