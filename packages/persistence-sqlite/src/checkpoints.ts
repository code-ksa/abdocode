/**
 * Durable checkpoints — a rebuildable projection that lets resume skip replaying
 * the whole log, WITHOUT being a second source of truth.
 *
 * The authority is the `run.checkpointed` event in the log. `run_checkpoints`
 * keeps only the latest checkpoint per run for fast lookup, and is rebuilt from
 * the events at startup. A checkpoint whose sequence exceeds the log's latest
 * (corrupt / ahead) is ignored and rebuilt.
 */
import { Database } from "bun:sqlite"
import type { DomainEvent } from "@abdo/contracts/event"
import { emptyProgress, type RunProgress } from "@abdo/contracts/run"

export const CHECKPOINT_EVENT = "run.checkpointed"

export type CheckpointPhase =
  | "input_promoted"
  | "model_completed"
  | "tool_pending"
  | "tool_completed"
  | "verification_completed"
  | "turn_completed"

export interface RunCheckpoint {
  readonly runId: string
  readonly sessionId: string
  readonly attempt: number
  readonly sequence: number
  readonly phase: CheckpointPhase
  readonly turn: number
  readonly pendingToolExecutionId?: string
  /** Executable meaning — what the runtime should do next. */
  readonly nextAction: "call_model" | "verify_tool" | "continue_after_tool_result" | "finalize_turn"
  /**
   * Sprint 12: the work as of this checkpoint — files changed, commands
   * completed, tests, the current blocker, the plan. Optional because
   * checkpoints written before Sprint 12 exist in real databases and must still
   * load; they read back as empty progress rather than as a crash.
   */
  readonly progress?: RunProgress
  readonly createdAt: number
}

const DDL = `
CREATE TABLE IF NOT EXISTS run_checkpoints (
  run_id                   TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL,
  attempt                  INTEGER NOT NULL,
  sequence                 INTEGER NOT NULL,
  phase                    TEXT NOT NULL,
  turn                     INTEGER NOT NULL,
  pending_tool_execution_id TEXT,
  next_action              TEXT NOT NULL,
  progress                 TEXT,
  created_at               INTEGER NOT NULL
);
`

export class CheckpointStore {
  private readonly db: Database

  constructor(filename: string) {
    this.db = new Database(filename, { create: true })
    this.db.run("PRAGMA busy_timeout = 5000;")
    this.db.run("PRAGMA journal_mode = WAL;")
    
    this.db.run(DDL)
    // `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
    // table, so a pre-Sprint-12 file would keep the old 9-column shape and every
    // INSERT would fail at runtime. The column is added in place instead — this
    // projection is rebuildable, but crashing on open is not a recovery story.
    const columns = this.db.query("PRAGMA table_info(run_checkpoints)").all() as { name: string }[]
    if (!columns.some((c) => c.name === "progress")) {
      this.db.run("ALTER TABLE run_checkpoints ADD COLUMN progress TEXT")
    }
  }

  close(): void {
    this.db.close()
  }

  record(cp: RunCheckpoint): void {
    this.db
      .query(
        `INSERT INTO run_checkpoints (run_id, session_id, attempt, sequence, phase, turn, pending_tool_execution_id, next_action, progress, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           attempt=excluded.attempt, sequence=excluded.sequence, phase=excluded.phase, turn=excluded.turn,
           pending_tool_execution_id=excluded.pending_tool_execution_id, next_action=excluded.next_action,
           progress=excluded.progress, created_at=excluded.created_at
         WHERE excluded.sequence >= run_checkpoints.sequence`,
      )
      .run(
        cp.runId,
        cp.sessionId,
        cp.attempt,
        cp.sequence,
        cp.phase,
        cp.turn,
        cp.pendingToolExecutionId ?? null,
        cp.nextAction,
        cp.progress ? JSON.stringify(cp.progress) : null,
        cp.createdAt,
      )
  }

  get(runId: string): RunCheckpoint | undefined {
    const r = this.db.query("SELECT * FROM run_checkpoints WHERE run_id = ?").get(runId) as CpRow | null
    return r ? fromRow(r) : undefined
  }

  /**
   * Rebuild the projection from the log. Keeps the latest valid checkpoint per
   * run; drops any whose sequence exceeds the log's latest (corrupt/ahead).
   */
  rebuildFrom(events: readonly DomainEvent[]): number {
    const maxSeq = events.reduce((m, e) => Math.max(m, Number(e.sequence)), -1)
    this.db.run("DELETE FROM run_checkpoints")
    const latest = new Map<string, RunCheckpoint>()
    for (const e of events) {
      if (e.type !== CHECKPOINT_EVENT) continue
      // sessionId lives on the event's aggregateId, not in the payload.
      const cp: RunCheckpoint = { ...(e.data as RunCheckpoint), sessionId: e.aggregateId }
      if (cp.sequence > maxSeq) continue // ahead of the log -> ignore
      const prev = latest.get(cp.runId)
      if (!prev || cp.sequence >= prev.sequence) latest.set(cp.runId, cp)
    }
    for (const cp of latest.values()) this.record(cp)
    return latest.size
  }
}

interface CpRow {
  run_id: string
  session_id: string
  attempt: number
  sequence: number
  phase: string
  turn: number
  pending_tool_execution_id: string | null
  next_action: string
  progress: string | null
  created_at: number
}

function fromRow(r: CpRow): RunCheckpoint {
  return {
    runId: r.run_id,
    sessionId: r.session_id,
    attempt: r.attempt,
    sequence: r.sequence,
    phase: r.phase as CheckpointPhase,
    turn: r.turn,
    pendingToolExecutionId: r.pending_tool_execution_id ?? undefined,
    nextAction: r.next_action as RunCheckpoint["nextAction"],
    progress: parseProgress(r.progress),
    createdAt: r.created_at,
  }
}

/**
 * A checkpoint whose progress is missing or unreadable reads as EMPTY progress,
 * never as absent. A resumer that gets `undefined` has to guess whether the run
 * did nothing or whether the record is old; empty progress with the run's own
 * log still available is the honest, non-guessing answer.
 */
function parseProgress(raw: string | null): RunProgress {
  if (!raw) return emptyProgress()
  try {
    const parsed = JSON.parse(raw) as Partial<RunProgress>
    return {
      plan: parsed.plan ?? [],
      filesChanged: parsed.filesChanged ?? [],
      commandsCompleted: parsed.commandsCompleted ?? [],
      tests: parsed.tests ?? [],
      ...(parsed.blocker ? { blocker: parsed.blocker } : {}),
    }
  } catch {
    return emptyProgress()
  }
}
