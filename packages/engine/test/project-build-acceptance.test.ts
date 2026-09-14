import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { projectBuildViolation } from "../src/project-build-acceptance"

const roots: string[] = []
const fixture = () => {
  const root = join(import.meta.dir, `.build-acceptance-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), '{"dependencies":{"next":"latest"}}')
  return root
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("project build acceptance", () => {
  test("rejects a zero-exit Next build that has no customer route", () => {
    expect(projectBuildViolation(fixture(), "Route (pages)\n─ ○ /404\nانتهى الأمر برمز 0")).toContain("404")
  })

  test("accepts a zero-exit Next build with an app router home page", () => {
    const root = fixture()
    mkdirSync(join(root, "app"), { recursive: true })
    writeFileSync(join(root, "app", "page.tsx"), "export default () => null")
    expect(projectBuildViolation(root, "Route (app)\n┌ ○ /\nانتهى الأمر برمز 0")).toBeUndefined()
  })

  test("leaves nonzero command failures to the ordinary command gate", () => {
    expect(projectBuildViolation(fixture(), "انتهى الأمر برمز 1")).toBeUndefined()
  })
})

describe("project build acceptance — explicit verdicts", () => {
  test("a failing verdict means the build did not exit zero: no violation is claimed even if the text says exit 0", () => {
    const output = "Route (pages)\n─ ○ /404\nانتهى الأمر برمز 0"
    const root = fixture()
    expect(projectBuildViolation(root, output)).toContain("404")
    expect(projectBuildViolation(root, output, { ok: false, reason: "aborted", denied: false })).toBeUndefined()
  })

  test("an ok verdict on a markerless build of a Next project without a home page is the 404-only violation", () => {
    const root = fixture()
    expect(projectBuildViolation(root, "Route (pages)\n─ ○ /404")).toBeUndefined()
    expect(projectBuildViolation(root, "Route (pages)\n─ ○ /404", { ok: true })).toContain("404")
  })
})
