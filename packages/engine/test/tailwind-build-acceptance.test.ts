/**
 * 10-09 — measured in the m11 comparison (Vite + Tailwind + SQLite): BOTH AbdoCode and OpenCode installed tailwindcss, the build exited 0,
 * and dist held no CSS at all. The build gate now asks the disk: a Vite project with tailwindcss must emit Tailwind CSS into dist.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { projectBuildViolation, tailwindBuildViolation } from "../src/project-build-acceptance"

const roots: string[] = []
const project = (deps: Record<string, string>, css?: string) => {
  const root = join(import.meta.dir, `.tw-build-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(join(root, "dist", "assets"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: deps }))
  writeFileSync(join(root, "dist", "index.html"), "<!doctype html><script src=assets/index.js></script>")
  writeFileSync(join(root, "dist", "assets", "index.js"), "console.log(1)")
  if (css !== undefined) writeFileSync(join(root, "dist", "assets", "index.css"), css)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("tailwind build acceptance", () => {
  test("Vite + tailwindcss 4 with no CSS in dist is a failed build, naming the v4 wiring", () => {
    const root = project({ vite: "^8.3.4", tailwindcss: "^4.3.3" })
    const why = projectBuildViolation(root, "built in 1.2s\nانتهى الأمر برمز 0")
    expect(why).toContain("@tailwindcss/vite")
    expect(why).toContain('@import "tailwindcss"')
  })

  test("v3 gets the PostCSS recipe; a CSS file without Tailwind output still fails", () => {
    const root = project({ vite: "^5.0.10", tailwindcss: "^3.4.1" }, "body{margin:0}")
    expect(tailwindBuildViolation(root)).toContain("@tailwind base")
  })

  test("the twin: compiled Tailwind in dist passes (v4 banner, or v3 --tw- variables)", () => {
    expect(tailwindBuildViolation(project({ vite: "^8", tailwindcss: "^4.3.3" }, "/*! tailwindcss v4.3.3 | MIT License */ .flex{display:flex}"))).toBeUndefined()
    expect(tailwindBuildViolation(project({ vite: "^5", tailwindcss: "^3.4.1" }, "*,:before{--tw-ring-offset-width:0px}"))).toBeUndefined()
  })

  test("not applicable: no tailwind, no vite, no dist yet, or a failing build", () => {
    expect(tailwindBuildViolation(project({ vite: "^8" }))).toBeUndefined()
    expect(tailwindBuildViolation(project({ next: "15", tailwindcss: "^4" }))).toBeUndefined()
    const noDist = project({ vite: "^8", tailwindcss: "^4" }); rmSync(join(noDist, "dist"), { recursive: true })
    expect(tailwindBuildViolation(noDist)).toBeUndefined()
    expect(projectBuildViolation(project({ vite: "^8", tailwindcss: "^4" }), "انتهى الأمر برمز 1")).toBeUndefined()
  })
})
