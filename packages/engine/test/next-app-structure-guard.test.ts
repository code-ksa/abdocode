import { describe, expect, test } from "bun:test"
import { nextAppPageShellViolation } from "../src/next-app-structure-guard"

const base = {
  projectDir: "C:\\project",
  normalizedTarget: "app/page.tsx",
  operation: "write" as const,
  before: "",
}

describe("Next App Router structure guard", () => {
  test("rejects a page that duplicates the layout document shell", () => {
    expect(nextAppPageShellViolation({
      ...base,
      after: 'export default () => <html lang="ar"><head /><body><main /></body></html>',
    })).toEqual(["html", "head", "body"])
  })

  test("rejects a page-level link to the global stylesheet", () => {
    expect(nextAppPageShellViolation({
      ...base,
      after: 'export default () => <link rel="stylesheet" href="/globals.css" />',
    })).toEqual(["رابط globals.css"])
  })

  test("allows semantic content that the root layout will wrap", () => {
    expect(nextAppPageShellViolation({ ...base, after: 'export default () => <main><h1>السعادة</h1></main>' })).toBeUndefined()
  })

  test("rejects a shared component that tries to become another document shell", () => {
    expect(nextAppPageShellViolation({
      ...base,
      normalizedTarget: "app/components/site-shell.tsx",
      after: 'export default () => <html><body /></html>',
    })).toEqual(["html", "body"])
  })
})
