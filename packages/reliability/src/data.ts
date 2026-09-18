/**
 * SQL (Sprint 49) and atomic file writing (Sprint 50).
 *
 * Both are about the same thing: an operation that looks like it worked.
 *
 * A query built by concatenation runs. It returns rows. It is also the single
 * most common way an agent destroys data it did not mean to touch, and the
 * quoting failure this program has hit for real is smaller and more annoying
 * than injection: Postgres folds unquoted identifiers to lower case, so
 * `SELECT projectId` on a camelCase column is not a subtle bug — it is a
 * "column does not exist" that the model then tries to fix by inventing a
 * different column name.
 *
 * The parameter trap here was found the hard way in another project:
 * placeholders bind BY APPEARANCE. Reusing `$1` twice shifts every later
 * parameter by one, and the query still runs, with the wrong values in the
 * wrong columns. So parameters are built by a function that cannot get this
 * wrong rather than by a human counting.
 *
 * A file write has the same shape of lie. `writeFile` that dies halfway leaves
 * a file that exists, has a plausible size, and is truncated — and every later
 * read treats it as the truth.
 */

export type SqlValue = string | number | boolean | null | Date | Uint8Array

export interface Query {
  readonly text: string
  readonly values: readonly SqlValue[]
}

/**
 * Quote an identifier for Postgres.
 *
 * Always quoted, never conditionally. "Quote it if it has capitals" is a rule
 * that works until a column is named `order` or `user`, and those are the two
 * most common column names in the world.
 */
export function quoteIdent(name: string): string {
  if (name.includes("\0")) throw new Error("an identifier containing a NUL byte is not an identifier")
  return `"${name.replace(/"/g, '""')}"`
}

export function quoteQualified(path: string): string {
  return path.split(".").map(quoteIdent).join(".")
}

/**
 * Build a parameterised query.
 *
 * Values NEVER reach the text. The template is a tagged-template style builder
 * so the only way to interpolate is through `param`, and a caller that wants
 * concatenation has to go and write a different function — which is the point:
 * the safe path must be the shortest one.
 */
export class QueryBuilder {
  private parts: string[] = []
  private values: SqlValue[] = []
  private seen = new Map<string, number>()

  raw(sql: string): this {
    this.parts.push(sql)
    return this
  }

  ident(name: string): this {
    this.parts.push(quoteQualified(name))
    return this
  }

  /**
   * Bind a value and emit its placeholder.
   *
   * Repeated values are DEDUPLICATED to one placeholder rather than appended
   * twice, and that is safe precisely because the builder — not a human —
   * assigns the numbers. Hand-written SQL that reuses `$1` shifts every later
   * parameter and still runs.
   */
  param(value: SqlValue): this {
    const key = `${typeof value}:${value instanceof Date ? value.toISOString() : String(value)}`
    const existing = this.seen.get(key)
    if (existing !== undefined) {
      this.parts.push(`$${existing}`)
      return this
    }
    this.values.push(value)
    const index = this.values.length
    this.seen.set(key, index)
    this.parts.push(`$${index}`)
    return this
  }

  list(values: readonly SqlValue[]): this {
    this.parts.push("(")
    values.forEach((v, i) => {
      if (i > 0) this.parts.push(", ")
      this.param(v)
    })
    this.parts.push(")")
    return this
  }

  build(): Query {
    return { text: this.parts.join(""), values: [...this.values] }
  }
}

export const sql = (): QueryBuilder => new QueryBuilder()

const MUTATING = /^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do)\b/i
const MULTI_STATEMENT = /;\s*\S/

/**
 * Blank out comments and string literals, preserving length.
 *
 * Length is preserved so any position reported later still lines up with the
 * original text — a sanitiser that changes offsets makes every error message
 * point at the wrong character.
 */
export function stripNonCode(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === "--") {
      const end = text.indexOf("\n", i)
      const stop = end === -1 ? text.length : end
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    const ch = text[i]!
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === ch && text[j + 1] === ch) {
          j += 2
          continue
        }
        if (text[j] === ch) break
        j++
      }
      const stop = Math.min(j + 1, text.length)
      out += " ".repeat(stop - i)
      i = stop
      continue
    }
    out += ch
    i++
  }
  return out
}

export interface SqlPolicyVerdict {
  readonly allowed: boolean
  readonly why: string
  readonly mutating: boolean
}

/**
 * Read-only enforcement, and the check that matters more than it looks.
 *
 * A trailing statement after a semicolon is how a read-only query stops being
 * one. `SELECT 1; DROP TABLE users` passes any check that only looks at the
 * first word.
 */
export function checkSqlPolicy(query: Query, mode: "read_only" | "read_write"): SqlPolicyVerdict {
  // RED TEAM S59. The check used to run over the raw text, so a semicolon
  // inside a comment or a string literal refused a legitimate query — and a
  // gate that refuses correct work is a gate people switch off, which is the
  // more dangerous failure. Comments and literals are blanked first, so the
  // check sees only executable text; `select ';'` passes and
  // `select 1; drop table users` still does not.
  const executable = stripNonCode(query.text)
  if (MULTI_STATEMENT.test(executable))
    return {
      allowed: false,
      mutating: true,
      why: "the text contains more than one statement — a check that reads only the first word would have passed this",
    }
  const mutating = MUTATING.test(executable)
  if (mode === "read_only" && mutating)
    return { allowed: false, mutating, why: "this connection is read-only and the statement mutates" }
  return { allowed: true, mutating, why: mutating ? "mutating statement on a read-write connection" : "read-only statement" }
}

export interface ResultShape {
  readonly columns: readonly string[]
  readonly rowCount: number
}

/**
 * Does the result look like what was asked for?
 *
 * A query returning zero rows and a query returning the wrong columns are
 * different failures and are usually confused: the first is data, the second
 * is a bug. Checking the columns catches a schema that moved under a query
 * nobody updated.
 */
export function checkResultShape(shape: ResultShape, expected: readonly string[]): { ok: boolean; why: string } {
  const missing = expected.filter((c) => !shape.columns.includes(c))
  if (missing.length > 0)
    return {
      ok: false,
      why: `the result is missing ${missing.join(", ")} — the schema moved under a query nobody updated (columns present: ${shape.columns.join(", ")})`,
    }
  return { ok: true, why: `${shape.rowCount} row(s), all expected columns present` }
}

// --------------------------------------------------------------------------
// Sprint 50 — atomic file writing
// --------------------------------------------------------------------------

/** The filesystem this needs. Injected; nothing here touches disk directly. */
export interface AtomicFs {
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  /** Flush to the physical device. Without this, rename can beat the data. */
  fsync?(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface AtomicWriteResult {
  readonly path: string
  readonly tempPath: string
  readonly bytes: number
  readonly fsynced: boolean
}

/**
 * Write a file so that a kill leaves either the old content or the new one.
 *
 * temp -> fsync -> rename. The rename is the atomic step on every filesystem
 * this runs on; everything before it happens in a file nobody reads.
 *
 * The fsync is not optional-in-spirit even though the port allows it to be
 * missing: without it the rename can be durable while the DATA is not, and the
 * crash leaves an intact directory entry pointing at zeros. When the port
 * cannot fsync, the result SAYS SO rather than claiming a guarantee it did not
 * provide.
 *
 * The temp file is removed on failure, but the failure is re-thrown: a write
 * that could not complete must not look like one that did.
 */
export async function writeAtomic(
  fs: AtomicFs,
  path: string,
  data: string,
  suffix = ".tmp",
): Promise<AtomicWriteResult> {
  const tempPath = `${path}${suffix}`
  try {
    await fs.writeFile(tempPath, data)
    let fsynced = false
    if (fs.fsync !== undefined) {
      await fs.fsync(tempPath)
      fsynced = true
    }
    await fs.rename(tempPath, path)
    return { path, tempPath, bytes: data.length, fsynced }
  } catch (e) {
    // leave nothing half-written behind, then let the caller know it failed
    await fs.remove(tempPath).catch(() => {})
    throw e
  }
}

/**
 * Temp files left by a process that died mid-write.
 *
 * Reported rather than deleted. A `.tmp` sitting next to a file is evidence
 * about a crash, and this program keeps deciding that evidence of a failure is
 * worth more than a tidy directory.
 */
export async function findAbandonedWrites(
  fs: AtomicFs,
  paths: readonly string[],
  suffix = ".tmp",
): Promise<string[]> {
  const found: string[] = []
  for (const path of paths) {
    if (await fs.exists(`${path}${suffix}`)) found.push(`${path}${suffix}`)
  }
  return found
}
