import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvePlan, planApprovalVerdict, planApproved, planDigest, planningToolAllowed, planningWriteViolation, projectDocumentReadLimit } from "../src/project-planning-phase"

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
    expect(projectDocumentReadLimit("ABDO-PLANS/auth.md", 6000)).toBe(14_000)
  })
  test("09-16: ABDO-PLANS/*.md and plan-approve belong to planning; deeper or elsewhere does not", () => {
    expect(planningWriteViolation("ABDO-PLANS/auth.md", true)).toBeUndefined()
    expect(planningWriteViolation("abdo-plans/Auth-v2.md", true)).toBeUndefined()
    for (const target of ["ABDO-PLANS/x/y.md", "ABDO-PLANS/notes.txt", "src/ABDO-PLANS/a.md"]) expect(planningWriteViolation(target, true)).toContain("مرحلة التخطيط")
    expect(planningWriteViolation("app/page.tsx", true)).toContain("plan-approve")
    expect(planningToolAllowed("plan-approve", true)).toBe(true)
    expect(planningToolAllowed("plan", true)).toBe(true)
  })
})

describe("09-16: plan approval — bound to the plan's digest, never implicit", () => {
  test("verdict: no plan, unapproved, approved, stale once the plan changes, stale on a corrupt record", () => {
    expect(planApprovalVerdict(undefined, undefined)).toBe("no-plan")
    expect(planApprovalVerdict("# plan", undefined)).toBe("unapproved")
    const record = JSON.stringify({ digest: planDigest("# plan") })
    expect(planApprovalVerdict("# plan", record)).toBe("approved")
    expect(planApprovalVerdict("# plan\r\n", JSON.stringify({ digest: planDigest("# plan\n") }))).toBe("approved") // CR لا يُسقط الاعتماد
    expect(planApprovalVerdict("# plan v2", record)).toBe("stale")
    expect(planApprovalVerdict("# plan", "{not json")).toBe("stale")
    expect(planApprovalVerdict("# plan", JSON.stringify({ digest: 42 }))).toBe("stale")
  })
  test("approvePlan writes the record; planApproved reads the disk back; editing the plan revokes it; no requirement means no gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-plan-"))
    expect(approvePlan(dir, "test").ok).toBe(false)
    expect(planApproved(dir, false)).toBe(true)
    expect(planApproved(dir, true)).toBe(false)
    writeFileSync(join(dir, "ABDO-SPRINTS.md"), "# plan")
    expect(planApproved(dir, true)).toBe(false)
    const approved = approvePlan(dir, "test")
    expect(approved.ok).toBe(true)
    expect(approved.text).toContain("اعتُمدت")
    expect(existsSync(join(dir, "ABDO-PLANS", "APPROVED.json"))).toBe(true)
    expect(planApproved(dir, true)).toBe(true)
    writeFileSync(join(dir, "ABDO-SPRINTS.md"), "# plan changed")
    expect(planApproved(dir, true)).toBe(false)
  })
})
