/**
 * Summary — a DERIVED view over current facts, never authoritative.
 *
 * It can be dropped and recomputed at any time from the FactStore. This is the
 * core correction to abdo's summary drift: the text summary is a projection
 * of structured facts, so it cannot silently lose a decision that still exists
 * as a verified fact.
 */
import { isActive, type Fact } from "./types"

export interface MemorySummary {
  readonly projectId: string
  readonly facts: readonly SummaryItem[]
  readonly decisions: readonly SummaryItem[]
  readonly activeTasks: readonly SummaryItem[]
  readonly knownErrors: readonly SummaryItem[]
  readonly serverInventory: readonly SummaryItem[]
  readonly serviceDependencies: readonly SummaryItem[]
  readonly deploymentTargets: readonly SummaryItem[]
  readonly credentialReferences: readonly SummaryItem[]
}

export interface SummaryItem {
  readonly key: string
  readonly value: unknown
  readonly status: string
  readonly confidence: number
}

const toItem = (f: Fact): SummaryItem => ({ key: f.key, value: f.value, status: f.status, confidence: f.confidence })

const sortByKey = (items: SummaryItem[]) => items.sort((a, b) => a.key.localeCompare(b.key))

/** Pure fold of current facts into a grouped summary. Deterministic. */
export function buildSummary(projectId: string, facts: readonly Fact[]): MemorySummary {
  const active = facts.filter((f) => f.projectId === projectId && isActive(f))
  const of = (kind: Fact["kind"]) => sortByKey(active.filter((f) => f.kind === kind).map(toItem))
  return {
    projectId,
    facts: of("project_fact"),
    decisions: of("architecture_decision"),
    activeTasks: of("active_task"),
    knownErrors: of("known_error"),
    serverInventory: of("server_inventory"),
    serviceDependencies: of("service_dependency"),
    deploymentTargets: of("deployment_target"),
    credentialReferences: of("credential_reference"),
  }
}
