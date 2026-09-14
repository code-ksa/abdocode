import { expect, test } from "bun:test"
import * as Contracts from "../src"

test("the owned domain barrel exposes every declared product domain", () => {
  expect(Object.keys(Contracts).toSorted()).toEqual([
    "BudgetDomain", "CapabilityDomain", "DomainError", "EventDomain", "EvidencePackDomain",
    "FailureDomain", "Id", "IdempotencyDomain", "MissionDomain", "PlanDomain", "ProbeDomain",
    "ReceiptDomain", "ReconciliationDomain", "RunDomain", "SessionDomain", "SliceDomain",
    "State", "ToolDomain", "Transition", "VerificationDomain", "WorkspaceDomain",
  ].toSorted())
})
