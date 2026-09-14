/**
 * Sprint 26 — the plan as a durable artifact.
 *
 * The gate decides; this is what it decides against. Approval is an EVENT, so
 * "was this approved?" is a question about the record — and an approval that
 * never happened cannot be remembered into existence.
 */
import { describe, expect, test } from "bun:test"
import { approvedPlanFor, foldPlans, isSelfApproved } from "@abdo/contracts/plan"
import { MemoryEventStore } from "@abdo/event-store"
import { PlanLedger } from "../src/plans"

const SID = "ses_plan"
const ledgerFor = () => {
  const store = new MemoryEventStore()
  return { store, ledger: new PlanLedger({ store, sessionId: SID }) }
}

describe("draft, critique, approve", () => {
  test("a plan carries its steps and the files they declare", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({
      planId: "plan_1",
      scope: "task_4",
      objective: "add the config loader",
      steps: [
        { summary: "write the loader", files: ["src/config.ts"] },
        { summary: "wire it up", files: ["src/index.ts", "src/config.ts"] },
      ],
    })
    const plan = foldPlans(await store.readAll())[0]!
    expect(plan.state).toBe("drafted")
    expect(plan.steps).toHaveLength(2)
    // declared files are de-duplicated across steps
    expect(plan.declaredFiles).toEqual(["src/config.ts", "src/index.ts"])
  })

  test("a critique with no concerns is still recorded — reviewed and clean is not the same as unreviewed", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "s", objective: "o", steps: [] })
    await ledger.critique("plan_1", "verifier", [])
    const plan = foldPlans(await store.readAll())[0]!
    expect(plan.state).toBe("critiqued")
    expect(plan.critiques).toHaveLength(1)
    expect(plan.critiques[0]!.concerns).toEqual([])
  })

  test("only an approved plan is found for a scope", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "task_4", objective: "o", steps: [] })
    expect(approvedPlanFor(await store.readAll(), "task_4")).toBeUndefined()

    await ledger.approve("plan_1", "owner")
    const found = approvedPlanFor(await store.readAll(), "task_4")!
    expect(found.planId).toBe("plan_1")
    expect(found.approvedBy).toBe("owner")
  })

  test("a rejected plan does not cover anything", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "task_4", objective: "o", steps: [] })
    await ledger.reject("plan_1", "the migration is not reversible")
    const plan = foldPlans(await store.readAll())[0]!
    expect(plan.state).toBe("rejected")
    expect(plan.rejectedReason).toContain("not reversible")
    expect(approvedPlanFor(await store.readAll(), "task_4")).toBeUndefined()
  })

  test("a superseded plan stops covering its scope", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "task_4", objective: "o", steps: [] })
    await ledger.approve("plan_1", "owner")
    expect(await ledger.approvedFor("task_4")).toBeDefined()
    await ledger.supersede("plan_1")
    expect(await ledger.approvedFor("task_4")).toBeUndefined()
  })

  test("the newest approval wins when a scope has more than one", async () => {
    const { ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "task_4", objective: "first", steps: [] })
    await ledger.approve("plan_1", "owner")
    await ledger.draft({ planId: "plan_2", scope: "task_4", objective: "second", steps: [] })
    await ledger.approve("plan_2", "owner")
    expect((await ledger.approvedFor("task_4"))!.planId).toBe("plan_2")
  })

  test("self-approval is visible rather than indistinguishable", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.draft({ planId: "plan_1", scope: "s", objective: "o", steps: [] })
    await ledger.approve("plan_1", "builder")
    const plan = foldPlans(await store.readAll())[0]!
    expect(isSelfApproved(plan, "builder")).toBe(true)
    expect(isSelfApproved(plan, "owner")).toBe(false)
  })

  test("an approval for a plan that was never drafted records nothing", async () => {
    const { store, ledger } = ledgerFor()
    await ledger.approve("plan_ghost", "owner")
    expect(foldPlans(await store.readAll())).toEqual([])
  })
})
