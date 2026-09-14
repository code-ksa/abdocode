import { describe, expect, test } from "bun:test"
import { correctionTopic, detectImplicitCorrection, inferredValue } from "../src/implicit-correction"

describe("implicit corrections", () => {
  test("Arabic and English correction phrasings yield to/from with a confidence that reflects explicitness", () => {
    expect(detectImplicitCorrection("لا، استخدم PostgreSQL بدل SQLite")).toMatchObject({ to: "PostgreSQL", from: "SQLite", topic: "database", confidence: 0.8 })
    expect(detectImplicitCorrection("بدل npm استخدم pnpm")).toMatchObject({ to: "pnpm", from: "npm", confidence: 0.75 })
    expect(detectImplicitCorrection("خليها Tailwind مش CSS عادي")).toMatchObject({ to: "Tailwind", from: "CSS عادي", confidence: 0.7 })
    expect(detectImplicitCorrection("لا استخدم الفرنسية في الردود")).toMatchObject({ to: "الفرنسية في الردود", confidence: 0.6 })
    expect(detectImplicitCorrection("دائماً استخدم اختبارات vitest")).toMatchObject({ to: "اختبارات vitest", topic: "tests", confidence: 0.55 })
    expect(detectImplicitCorrection("Actually, use pnpm instead of npm.")).toMatchObject({ to: "pnpm", from: "npm", confidence: 0.8 })
    expect(detectImplicitCorrection("instead of Prisma, go with Drizzle")).toMatchObject({ to: "Drizzle", from: "Prisma", confidence: 0.75 })
    expect(detectImplicitCorrection("use bun not npm")).toMatchObject({ to: "bun", from: "npm", confidence: 0.7 })
    expect(detectImplicitCorrection("No, make it dark mode by default")).toMatchObject({ to: "dark mode by default", confidence: 0.6 })
    expect(detectImplicitCorrection("From now on, prefer server components")).toMatchObject({ to: "server components", confidence: 0.55 })
  })

  test("questions, quotes, commands, long or multi-line text and credentials never become memory", () => {
    for (const text of [
      "هل نستخدم PostgreSQL بدل SQLite؟",
      "use pnpm instead of npm?",
      "/remember database: PostgreSQL",
      "> use pnpm instead of npm",
      "```\nuse pnpm instead of npm\n```",
      "use pnpm instead of npm\nand also update the docs",
      "نفّذ: run use pnpm instead of npm",
      "use the key sk-fixture123456789012345678901234 instead of the old one",
      "use https://example.com instead of the mirror",
      "use " + "x".repeat(130) + " instead of y",
      "use npm instead of npm",
      "let's build the invoice page now",
      "",
    ]) expect(detectImplicitCorrection(text)).toBeUndefined()
  })

  test("topics come from the shared concept vocabulary, else the first content word", () => {
    expect(correctionTopic("PostgreSQL", "SQLite")).toBe("database")
    expect(correctionTopic("Tailwind", "plain CSS")).toBe("style")
    expect(correctionTopic("pnpm", "npm")).toBe("pnpm")
    expect(inferredValue({ topic: "database", to: "PostgreSQL", from: "SQLite", confidence: 0.8, pattern: "x" })).toEqual({ note: "PostgreSQL (not SQLite)", to: "PostgreSQL", from: "SQLite", confidence: 0.8, inferred: true })
  })
})
