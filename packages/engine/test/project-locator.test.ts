import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultProjectRoots, locateProjects, nameTokens, skeleton } from "../src/project-locator"

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "abdo-locator-"))
  const documents = join(home, "Documents"), projects = join(home, "workspace", "projects")
  for (const dir of [
    join(documents, "rodud"), join(documents, "crm-board", ".git"), join(documents, "mosaiden-work"),
    join(documents, "node_modules", "rodud-fake"), join(documents, ".hidden-rodud"),
    join(projects, "eagle-ksa"), join(projects, "rodud-mobile"), join(projects, "unified-business-os"),
    join(home, "elsewhere", "rodud-copy"),
  ]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(documents, "rodud", "package.json"), "{}")
  writeFileSync(join(documents, "rodud", "PLAN.md"), "- [ ] ship")
  writeFileSync(join(documents, "rodud", "ABDO-AWARENESS.md"), "# ABDO-AWARENESS")
  return { home, documents, projects, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe("project locator", () => {
  test("tokens and skeletons bridge Arabic and Latin names", () => {
    expect(nameTokens("مشروع رُودود!")).toEqual(["مشروع", "رودود"])
    // د5 — الطيُّ من @abdo/semantic لا من نسخةٍ محلّية: الهمزتان ؤ/ئ والأرقامُ الهندية تُطوى هنا أيضاً (كانتا لا تُطوى).
    expect(nameTokens("مؤسسة الرياض")).toEqual(nameTokens("موسسه الرياض"))
    expect(nameTokens("مشروع ٢٠٢٦")).toEqual(["مشروع", "2026"])
    expect(skeleton("رودود")).toBe(skeleton("rodud"))
    expect(skeleton("مساعدين")).toBe(skeleton("mosaiden"))
    expect(skeleton("نسر")).toBe(skeleton("nsr"))
  })

  test("an Arabic spoken name finds the Latin folder, ranked above weaker matches, skipping hidden and dependency folders", () => {
    const f = fixture()
    try {
      const roots = defaultProjectRoots({ documents: f.documents, configured: [f.projects], selectedProject: join(f.projects, "eagle-ksa") })
      expect(roots).toEqual([f.projects, f.documents])
      const found = locateProjects("مشروع رودود", roots)
      expect(found.candidates.map((c) => c.name)).toEqual(["rodud", "rodud-mobile"])
      expect(found.candidates[0]).toMatchObject({ path: join(f.documents, "rodud"), signals: { git: false, packageJson: true, plans: ["PLAN.md"], awareness: true } })
      expect(found.candidates[0]!.matched).toEqual(["رودود"])
      expect(found.candidates[0]!.score).toBeGreaterThan(found.candidates[1]!.score)
      expect(found.candidates.some((c) => c.path.includes("node_modules") || c.name.startsWith("."))).toBe(false)
      expect(found.candidates.some((c) => c.path.includes("elsewhere"))).toBe(false)
      expect(found.truncated).toBe(false)
    } finally { f.cleanup() }
  })

  test("Latin queries match exact, prefix and container-nested folders; stop words never match", () => {
    const f = fixture()
    try {
      const roots = [f.documents, join(f.home, "workspace")]
      expect(locateProjects("crm", roots).candidates[0]).toMatchObject({ name: "crm-board", signals: { git: true } })
      expect(locateProjects("eagle project", roots).candidates.map((c) => c.name)).toEqual(["eagle-ksa"])
      expect(locateProjects("the project", roots).candidates).toEqual([])
      expect(locateProjects("business os", roots).candidates.map((c) => c.name)).toEqual(["unified-business-os"])
    } finally { f.cleanup() }
  })

  test("an absolute path is answered directly and never scanned; a relative traversal is not a path", () => {
    const f = fixture()
    try {
      const direct = locateProjects(join(f.documents, "rodud"), [])
      expect(direct.candidates).toHaveLength(1)
      expect(direct.scanned).toBe(1)
      expect(locateProjects(join(f.documents, "missing"), []).candidates).toEqual([])
      expect(locateProjects("../rodud", [f.documents]).candidates.map((c) => c.name)).toEqual(["rodud"])
    } finally { f.cleanup() }
  })

  test("the scan is bounded and reports truncation instead of walking forever", () => {
    const home = mkdtempSync(join(tmpdir(), "abdo-locator-wide-"))
    try {
      for (let i = 0; i < 700; i++) mkdirSync(join(home, `folder-${i}`))
      mkdirSync(join(home, "zz-target-rodud"))
      const found = locateProjects("rodud", [home])
      expect(found.scanned).toBeLessThanOrEqual(600)
      expect(found.truncated).toBe(true)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
