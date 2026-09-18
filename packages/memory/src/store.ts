/**
 * FactStore — the structured memory itself.
 *
 * Invariants that make this trustworthy where a text summary is not:
 *   - a fact reaches `verified` only with >=1 source event id (provenance)
 *   - superseding a fact never deletes it; the old one is marked `superseded`
 *     with a validUntil, so history and "why it changed" survive
 *   - credential_reference values must be a store reference, never a raw secret
 *
 * Reference implementation is in-memory; a durable adapter can mirror it later
 * exactly like persistence-sqlite mirrors the event store.
 */
import { CREDENTIAL_REFERENCE, type Fact, type FactKind, type RecordFactInput } from "./types"
import { validFor, type Query } from "./validity"

let counter = 0
const newId = () => `fct_${Date.now().toString(36)}_${(counter++).toString(36)}`

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvenanceError"
  }
}

export class CredentialLeakError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialLeakError"
  }
}

export class FactStore {
  private readonly facts = new Map<string, Fact>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Record a new candidate fact. Verified requires a later verify() with a source. */
  record(input: RecordFactInput): Fact {
    if (input.kind === "credential_reference") this.assertReference(input.value)
    const at = this.now()
    const fact: Fact = {
      id: newId(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      kind: input.kind,
      key: input.key,
      value: input.value,
      status: "candidate",
      confidence: input.confidence ?? 0.5,
      sourceEventIds: input.sourceEventIds ?? [],
      sourceFilePaths: input.sourceFilePaths ?? [],
      sourceGitCommit: input.sourceGitCommit,
      validFrom: at,
      expiresAt: input.expiresAt,
      createdAt: at,
    }
    this.facts.set(fact.id, fact)
    return fact
  }

  /** Promote a fact to verified — only if it carries provenance. */
  verify(id: string): Fact {
    const fact = this.require(id)
    if (fact.sourceEventIds.length === 0 && fact.sourceFilePaths.length === 0) {
      throw new ProvenanceError(`cannot verify ${id}: no documented source`)
    }
    const updated: Fact = { ...fact, status: "verified", verifiedAt: this.now() }
    this.facts.set(id, updated)
    return updated
  }

  /** Replace an old fact with a new one; the old becomes superseded (kept). */
  supersede(oldId: string, input: RecordFactInput): Fact {
    const old = this.require(oldId)
    const at = this.now()
    this.facts.set(oldId, { ...old, status: "superseded", validUntil: at })
    const next = this.record(input)
    const linked: Fact = { ...next, supersedesId: oldId }
    this.facts.set(next.id, linked)
    return linked
  }

  invalidate(id: string): Fact {
    const updated: Fact = { ...this.require(id), status: "invalid", validUntil: this.now() }
    this.facts.set(id, updated)
    return updated
  }

  get(id: string): Fact | undefined {
    return this.facts.get(id)
  }

  /**
   * Facts this query is entitled to use.
   *
   * Routed through the one validity rule rather than filtering here. The
   * previous version checked project and status only: it would have served a
   * fact whose `validUntil` had passed, and once S130 added TTL and session
   * scope it would have served those too. A filter that happens to be right
   * because the fields it ignores are never set is not a closed hole.
   */
  current(projectId: string, kind?: FactKind, options?: { readonly now?: number; readonly sessionId?: string }): Fact[] {
    const query: Query = {
      projectId,
      sessionId: options?.sessionId,
      now: options?.now ?? this.now(),
      kind,
    }
    return [...this.facts.values()].filter((fact) => validFor(fact, query).ok)
  }

  /** Every fact including retired ones — for audit and summary rebuild. */
  all(): Fact[] {
    return [...this.facts.values()]
  }

  private require(id: string): Fact {
    const fact = this.facts.get(id)
    if (!fact) throw new Error(`no such fact: ${id}`)
    return fact
  }

  private assertReference(value: unknown): void {
    if (typeof value !== "string" || !CREDENTIAL_REFERENCE.test(value)) {
      throw new CredentialLeakError(
        "credential_reference value must be a store reference like vault://... , not a raw secret",
      )
    }
  }
}
