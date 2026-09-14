import { Database } from "bun:sqlite"
import { CREDENTIAL_REFERENCE, type Fact, type FactKind, type RecordFactInput } from "./types"
import { recall, type RecallResult } from "./recall"
import type { Query } from "./validity"

/**
 * S130 — the durable memory, on `bun:sqlite`.
 *
 * # Why this is not a second FactStore
 *
 * It would be very easy for it to be. Two stores with their own copies of
 * "verified needs provenance", "a credential must be a reference", "expired
 * facts are not served" is the exact shape of the defect class this tree keeps
 * paying for — and the disagreement would be invisible, because each store
 * would pass its own tests. So the invariants live in `validity.ts` and the
 * credential rule in `types.ts`, and this file owns **only** what is genuinely
 * about SQLite: a schema, encoding, and decoding.
 *
 * `sqlite-store.test.ts` runs the same behavioural suite against both stores,
 * so "they agree" is a checked claim rather than an intention.
 *
 * # Why validity is not a WHERE clause
 *
 * It would be faster. It would also be a third copy of the rule, written in a
 * different language, in a place where nobody would think to look when the
 * rule changed. Rows come out and the shared judgement decides; if that ever
 * becomes the bottleneck, the fix is an index, not a second rulebook.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_event_ids TEXT NOT NULL,
  source_file_paths TEXT NOT NULL,
  source_git_commit TEXT,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  expires_at INTEGER,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS facts_by_project ON facts (project_id, status);
`

interface Row {
  readonly id: string
  readonly project_id: string
  readonly session_id: string | null
  readonly kind: string
  readonly key: string
  readonly value: string
  readonly status: string
  readonly confidence: number
  readonly source_event_ids: string
  readonly source_file_paths: string
  readonly source_git_commit: string | null
  readonly valid_from: number
  readonly valid_until: number | null
  readonly expires_at: number | null
  readonly supersedes_id: string | null
  readonly created_at: number
  readonly verified_at: number | null
}

const optional = <A>(value: A | null): A | undefined => (value === null ? undefined : value)

const toFact = (row: Row): Fact => ({
  id: row.id,
  projectId: row.project_id,
  sessionId: optional(row.session_id),
  kind: row.kind as FactKind,
  key: row.key,
  value: JSON.parse(row.value) as unknown,
  status: row.status as Fact["status"],
  confidence: row.confidence,
  sourceEventIds: JSON.parse(row.source_event_ids) as string[],
  sourceFilePaths: JSON.parse(row.source_file_paths) as string[],
  sourceGitCommit: optional(row.source_git_commit),
  validFrom: row.valid_from,
  validUntil: optional(row.valid_until),
  expiresAt: optional(row.expires_at),
  supersedesId: optional(row.supersedes_id),
  createdAt: row.created_at,
  verifiedAt: optional(row.verified_at),
})

export class SqliteFactStore {
  private readonly db: Database
  private counter = 0

  constructor(
    path = ":memory:",
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(path)
    this.db.exec(SCHEMA)
    // Reopening a durable store in a new process must not issue fct_0001
    // again: INSERT OR REPLACE would silently erase the previous fact.
    const ids = this.db.query<{ id: string }, []>("SELECT id FROM facts WHERE id GLOB 'fct_*'").all()
    this.counter = ids.reduce((highest, row) => {
      const parsed = Number.parseInt(row.id.slice(4), 36)
      return Number.isSafeInteger(parsed) ? Math.max(highest, parsed) : highest
    }, 0)
  }

  close(): void {
    this.db.close()
  }

  private newId(): string {
    // Deterministic within a store instance, so a golden trace over a run of
    // this store does not carry a clock.
    this.counter += 1
    return `fct_${this.counter.toString(36).padStart(4, "0")}`
  }

  record(input: RecordFactInput): Fact {
    if (input.kind === "credential_reference" && !this.isReference(input.value)) {
      throw new Error(
        "credential_reference value must be a store reference like vault://... , not a raw secret",
      )
    }
    const at = this.now()
    const fact: Fact = {
      id: this.newId(),
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
    this.insert(fact)
    return fact
  }

  verify(id: string): Fact {
    const fact = this.require(id)
    if (fact.sourceEventIds.length === 0 && fact.sourceFilePaths.length === 0) {
      throw new Error(`cannot verify ${id}: no documented source`)
    }
    const updated: Fact = { ...fact, status: "verified", verifiedAt: this.now() }
    this.insert(updated)
    return updated
  }

  supersede(oldId: string, input: RecordFactInput): Fact {
    const old = this.require(oldId)
    const at = this.now()
    // One transaction: a supersede that retired the old fact and then failed to
    // write the new one would leave the run with no memory of either.
    return this.db.transaction(() => {
      this.insert({ ...old, status: "superseded", validUntil: at })
      const next = this.record(input)
      const linked: Fact = { ...next, supersedesId: oldId }
      this.insert(linked)
      return linked
    })()
  }

  invalidate(id: string): Fact {
    const updated: Fact = { ...this.require(id), status: "invalid", validUntil: this.now() }
    this.insert(updated)
    return updated
  }

  /** Atomically correct one scoped memory, retaining retired revisions for audit. */
  replaceVerified(input: RecordFactInput): Fact {
    return this.db.transaction(() => {
      const previous = this.candidates(input.projectId).filter(fact =>
        fact.kind === input.kind && fact.key === input.key && fact.sessionId === input.sessionId &&
        (fact.status === "candidate" || fact.status === "verified"))
      const latest = previous.at(-1)
      const candidate = latest ? this.supersede(latest.id, input) : this.record(input)
      const verified = this.verify(candidate.id)
      for (const older of previous.slice(0, -1)) this.insert({ ...older, status: "superseded", validUntil: verified.validFrom })
      return verified
    })()
  }

  get(id: string): Fact | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM facts WHERE id = ?").get(id)
    return row === null ? undefined : toFact(row)
  }

  all(): Fact[] {
    return this.db
      .query<Row, []>("SELECT * FROM facts ORDER BY created_at, id")
      .all()
      .map(toFact)
  }

  /** Candidate rows for a project — narrowing only, never judging. */
  private candidates(projectId: string): Fact[] {
    return this.db
      .query<Row, [string]>("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId)
      .map(toFact)
  }

  current(projectId: string, kind?: FactKind, options?: { readonly now?: number; readonly sessionId?: string }): Fact[] {
    return this.query({
      projectId,
      kind,
      sessionId: options?.sessionId,
      now: options?.now ?? this.now(),
    }).facts as Fact[]
  }

  /** Recall with the audit attached. The path a run should use. */
  query(query: Query): RecallResult {
    return recall(this.candidates(query.projectId), query)
  }

  private insert(fact: Fact): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO facts
         (id, project_id, session_id, kind, key, value, status, confidence, source_event_ids,
          source_file_paths, source_git_commit, valid_from, valid_until, expires_at, supersedes_id,
          created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.projectId,
        fact.sessionId ?? null,
        fact.kind,
        fact.key,
        JSON.stringify(fact.value ?? null),
        fact.status,
        fact.confidence,
        JSON.stringify(fact.sourceEventIds),
        JSON.stringify(fact.sourceFilePaths),
        fact.sourceGitCommit ?? null,
        fact.validFrom,
        fact.validUntil ?? null,
        fact.expiresAt ?? null,
        fact.supersedesId ?? null,
        fact.createdAt,
        fact.verifiedAt ?? null,
      )
  }

  private require(id: string): Fact {
    const fact = this.get(id)
    if (fact === undefined) throw new Error(`no such fact: ${id}`)
    return fact
  }

  private isReference(value: unknown): boolean {
    return typeof value === "string" && CREDENTIAL_REFERENCE.test(value)
  }
}

export * as SqliteMemory from "./sqlite-store"
