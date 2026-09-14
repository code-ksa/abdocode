import { describe, expect, test } from "bun:test"
import { planningToolAllowed, planningWriteViolation, projectDocumentReadLimit } from "../src/project-planning-phase"

describe("explicit autonomous planning phase", () => {
  test("offers only project inspection and guarded file tools", () => {
    for (const name of ["read", "list", "glob", "grep", "write", "edit"]) expect(planningToolAllowed(name, true)).toBe(true)
    for (const name of ["run", "packages", "search", "fetch", "git-commit", "codemode", "external.call"]) expect(planningToolAllowed(name, true)).toBe(false)
  })
  test("permits only the plan and durable handoff as planning outputs", () => {
    expect(planningWriteViolation("./ABDO-SPRINTS.md", true)).toBeUndefined()
    expect(planningWriteViolation("ABDO-HANDOFF.md", true)).toBeUndefined()
    for (const target of ["package.json", "app/page.tsx", "../ABDO-SPRINTS.md", "nested/ABDO-SPRINTS.md"]) expect(planningWriteViolation(target, true)).toContain("مرحلة التخطيط")
  })
  test("does not restrict an execution phase", () => {
    expect(planningToolAllowed("run", false)).toBe(true)
    expect(planningWriteViolation("package.json", false)).toBeUndefined()
  })
  test("reads a whole bounded autonomous plan and handoff without expanding ordinary reads", () => {
    expect(projectDocumentReadLimit("ABDO-SPRINTS.md", 6000)).toBe(14_000)
    expect(projectDocumentReadLimit("./ABDO-HANDOFF.md", 6000)).toBe(14_000)
    expect(projectDocumentReadLimit("app/page.tsx", 6000)).toBe(6000)
  })
})
