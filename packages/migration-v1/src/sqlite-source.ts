/**
 * SqliteV1Source — reads a legacy abdo sqlite database READ-ONLY.
 *
 * Opened with `readonly: true`; there is no code path here that writes to the
 * source. Column names are read defensively so minor schema drift (snake vs
 * camel, missing optional columns) degrades to a warning, not a crash.
 */
import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import type { V1Message, V1Part, V1Session, V1Source } from "./types"

const pick = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k]
  return undefined
}

export class SqliteV1Source implements V1Source {
  private readonly db: Database

  constructor(private readonly filename: string) {
    // readonly + no create: we must never touch the source db.
    this.db = new Database(filename, { readonly: true })
  }

  private rows(table: string): Record<string, unknown>[] {
    try {
      return this.db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
    } catch {
      return [] // table absent -> importer records a warning
    }
  }

  *sessions(): Iterable<V1Session> {
    for (const r of this.rows("session")) {
      const archived = pick(r, ["archived", "is_archived"])
      yield {
        id: String(pick(r, ["id"]) ?? ""),
        title: pick(r, ["title"]) as string | undefined,
        directory: pick(r, ["directory", "cwd"]) as string | undefined,
        createdAt: pick(r, ["created", "created_at", "createdAt"]) as number | undefined,
        archived: archived === undefined ? undefined : Boolean(archived),
      }
    }
  }

  /** SHA-256 of the source db file — prove it is byte-identical after import. */
  fileHash(): string {
    return createHash("sha256").update(readFileSync(this.filename)).digest("hex")
  }

  *messages(): Iterable<V1Message> {
    for (const r of this.rows("message")) {
      yield {
        id: String(pick(r, ["id"]) ?? ""),
        sessionId: String(pick(r, ["session_id", "sessionId", "session"]) ?? ""),
        role: pick(r, ["role"]) as string | undefined,
        createdAt: pick(r, ["created", "created_at", "createdAt"]) as number | undefined,
      }
    }
  }

  *parts(): Iterable<V1Part> {
    for (const r of this.rows("part")) {
      const raw = pick(r, ["data"])
      let data: unknown = raw
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw)
        } catch {
          data = raw
        }
      }
      yield {
        id: String(pick(r, ["id"]) ?? ""),
        messageId: String(pick(r, ["message_id", "messageId", "message"]) ?? ""),
        type: pick(r, ["type", "kind"]) as string | undefined,
        data,
      }
    }
  }

  close(): void {
    this.db.close()
  }
}
