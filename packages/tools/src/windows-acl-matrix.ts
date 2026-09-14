/**
 * CL-16A3-B2B §1 — the formal Windows ACL rights matrix.
 *
 * This is the MEASURED result of CL-16A3-B2A turned into a contract. Every row
 * was established by a native Win32 call inside a real zero-capability
 * AppContainer — `CreateFileW`, `FindFirstFileW`, `DeleteFileW` and friends —
 * not by running `cmd` and reading its exit code. That distinction matters
 * because it is exactly where the previous slice went wrong: `cmd dir` fails on a
 * directory where `FindFirstFileW` succeeds, so cmd's failure described cmd.
 *
 * TWO RULES THIS ENCODES, both of which cost a slice to learn:
 *
 *  1. **A right is a mask AND a target.** The same mask on `object_self` and on
 *     `descendants` are different grants. The old model had only masks, so
 *     "this directory only" was inexpressible and ACEs landed where they were
 *     not meant.
 *  2. **Bits are aliased by object type.** On a directory `FILE_READ_DATA`
 *     (0x1) IS `FILE_LIST_DIRECTORY`, `FILE_WRITE_DATA` (0x2) is
 *     `FILE_ADD_FILE`, and `FILE_APPEND_DATA` (0x4) is
 *     `FILE_ADD_SUBDIRECTORY`. So "readable but not listable" is achieved by
 *     granting read on the FILE and only traverse on its directory — which was
 *     measured to work.
 *
 * `modify` is deliberately NOT usable here. It survives in the helper only as a
 * legacy alias, and `expandAlias` below forces any alias to become an explicit
 * list of named rights before a decision or a TOCTOU hash is taken.
 */

export const RIGHTS_MODEL_VERSION = 1
/** The slice whose native canaries produced the `canary` column. */
export const RIGHTS_EVIDENCE_VERSION = "CL-16A3-B2A"

export type AclObjectType = "file" | "directory"

/** Where the ACE applies. Mirrors `acl::target_flags` in the helper. */
export type AclTarget = "object_self" | "self_and_descendants" | "child_files" | "child_directories" | "immediate_children" | "descendants"

/** Inheritance flag values, from the documented ACE header constants. */
export const INHERIT_FLAGS: Record<AclTarget, number> = {
  object_self: 0x0,
  self_and_descendants: 0x1 | 0x2,
  child_files: 0x1 | 0x8,
  child_directories: 0x2 | 0x8,
  descendants: 0x1 | 0x2 | 0x8,
  immediate_children: 0x1 | 0x2 | 0x8 | 0x4,
}

/**
 * Single documented Win32 file-access rights. These MUST equal the values in
 * `acl.rs`; a test compares the two files so the two languages cannot drift.
 */
export const RIGHT_BITS = {
  FILE_READ_DATA_OR_LIST: 0x0001,
  FILE_WRITE_DATA_OR_ADD_FILE: 0x0002,
  FILE_APPEND_OR_ADD_SUBDIR: 0x0004,
  FILE_READ_EA: 0x0008,
  FILE_WRITE_EA: 0x0010,
  FILE_EXECUTE_OR_TRAVERSE: 0x0020,
  FILE_DELETE_CHILD: 0x0040,
  FILE_READ_ATTRIBUTES: 0x0080,
  FILE_WRITE_ATTRIBUTES: 0x0100,
  DELETE: 0x0001_0000,
  READ_CONTROL: 0x0002_0000,
  SYNCHRONIZE: 0x0010_0000,
} as const

/** Named rights, mirroring `acl::named_right`. SYNCHRONIZE is always folded in. */
export const NAMED_RIGHTS: Record<string, number> = {
  traverse: RIGHT_BITS.FILE_EXECUTE_OR_TRAVERSE | RIGHT_BITS.FILE_READ_ATTRIBUTES,
  read_attributes: RIGHT_BITS.FILE_READ_ATTRIBUTES,
  read_file: RIGHT_BITS.FILE_READ_DATA_OR_LIST | RIGHT_BITS.FILE_READ_EA | RIGHT_BITS.FILE_READ_ATTRIBUTES | RIGHT_BITS.READ_CONTROL,
  execute: RIGHT_BITS.FILE_EXECUTE_OR_TRAVERSE | RIGHT_BITS.FILE_READ_ATTRIBUTES | RIGHT_BITS.READ_CONTROL,
  list_directory: RIGHT_BITS.FILE_READ_DATA_OR_LIST | RIGHT_BITS.FILE_READ_ATTRIBUTES,
  create_file: RIGHT_BITS.FILE_WRITE_DATA_OR_ADD_FILE | RIGHT_BITS.FILE_READ_ATTRIBUTES,
  create_directory: RIGHT_BITS.FILE_APPEND_OR_ADD_SUBDIR | RIGHT_BITS.FILE_READ_ATTRIBUTES,
  write_file: RIGHT_BITS.FILE_WRITE_DATA_OR_ADD_FILE | RIGHT_BITS.FILE_WRITE_EA | RIGHT_BITS.FILE_WRITE_ATTRIBUTES,
  append: RIGHT_BITS.FILE_APPEND_OR_ADD_SUBDIR,
  delete: RIGHT_BITS.DELETE,
  delete_child: RIGHT_BITS.FILE_DELETE_CHILD,
}

export const maskOf = (named: readonly string[]): number => named.reduce((m, n) => m | (NAMED_RIGHTS[n] ?? 0) | RIGHT_BITS.SYNCHRONIZE, 0) >>> 0

/** Aliases are expanded BEFORE any decision or hash — never carried forward. */
const ALIASES: Record<string, readonly string[]> = {
  rx: ["read_file", "execute"],
  modify: ["read_file", "write_file", "create_file", "append", "delete", "execute"],
}

export function expandAlias(spec: readonly string[]): string[] {
  const out: string[] = []
  for (const s of spec) {
    const alias = ALIASES[s]
    if (alias) out.push(...alias)
    else out.push(s)
  }
  return [...new Set(out)].sort()
}

export interface AclOperationRow {
  readonly operation: string
  readonly objectType: AclObjectType
  readonly target: AclTarget
  readonly namedRights: readonly string[]
  readonly mask: number
  readonly inheritFlags: number
  readonly requirement: "required" | "optional"
  /** What the NATIVE Win32 canary observed. */
  readonly canary: "allowed" | "denied"
  /** `GetLastError` when the operation is denied without this grant. 5 = ACCESS_DENIED. */
  readonly denialError: number
  readonly evidenceVersion: string
  readonly note?: string
}

const row = (
  operation: string,
  objectType: AclObjectType,
  target: AclTarget,
  namedRights: readonly string[],
  requirement: "required" | "optional",
  note?: string,
): AclOperationRow => ({
  operation,
  objectType,
  target,
  namedRights,
  mask: maskOf(namedRights),
  inheritFlags: INHERIT_FLAGS[target],
  requirement,
  canary: "allowed",
  denialError: 5,
  evidenceVersion: RIGHTS_EVIDENCE_VERSION,
  ...(note ? { note } : {}),
})

/**
 * THE MATRIX. Each row is the LEAST grant measured sufficient for its operation.
 */
export const WINDOWS_ACL_MATRIX: readonly AclOperationRow[] = [
  row("ancestor_traverse", "directory", "object_self", ["traverse"], "required", "walk through only; grants no listing and no read"),
  row("file_read", "file", "object_self", ["read_file"], "required", "granted per FILE: a sibling without its own ACE stays denied"),
  row("file_attributes", "file", "object_self", ["read_attributes"], "optional"),
  row("executable_execute", "file", "object_self", ["execute", "read_file"], "required", "an image is mapped, so it is read as well as executed"),
  row("directory_enumeration", "directory", "object_self", ["traverse", "list_directory"], "optional", "FindFirstFileW succeeds; leaks no read, write or delete"),
  row("create_file", "directory", "object_self", ["traverse", "create_file"], "required"),
  row("create_directory", "directory", "object_self", ["traverse", "create_directory"], "optional"),
  row("write_file", "file", "object_self", ["write_file"], "required"),
  row("append_file", "file", "object_self", ["append"], "optional"),
  row("delete_file_via_object_delete", "file", "object_self", ["delete"], "required", "DELETE on the file itself"),
  row("delete_file_via_parent", "directory", "object_self", ["traverse", "delete_child"], "optional", "FILE_DELETE_CHILD on the parent; INHERIT_ONLY does NOT grant it"),
  row("directory_removal", "directory", "object_self", ["delete"], "optional"),
  // The write side of a per-run temp: children inherit so a created file is usable.
  row("temp_child_files", "directory", "child_files", ["read_file", "write_file", "append", "delete"], "optional", "inherited by files created in temp"),
]

export const rowFor = (operation: string): AclOperationRow | undefined => WINDOWS_ACL_MATRIX.find((r) => r.operation === operation)

/** Everything the matrix asserts, hashed, so a decision can be bound to it. */
export function rightsPlanHash(rows: readonly AclOperationRow[] = WINDOWS_ACL_MATRIX): string {
  const canonical = JSON.stringify({
    v: RIGHTS_MODEL_VERSION,
    evidence: RIGHTS_EVIDENCE_VERSION,
    rows: rows.map((r) => [r.operation, r.objectType, r.target, [...r.namedRights].sort(), r.mask, r.inheritFlags]),
  })
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** No row may request Full Control, or anything close to it. */
export const FORBIDDEN_MASK_BITS = 0xF000_0000 | 0x0004_0000 | 0x0008_0000 // GENERIC_*, WRITE_DAC, WRITE_OWNER

// ───────────────────────── host-side validation, BEFORE any intent or mutation

/** One requested grant, as a production plan expresses it. */
export interface AclGrantRequest {
  readonly path: string
  readonly operation: string
  readonly target: AclTarget
  readonly namedRights: readonly string[]
}

export type AclPlanVerdict =
  | { readonly ok: true; readonly mask: number; readonly resolved: readonly AclGrantRequest[] }
  | { readonly ok: false; readonly reasonCode: "windows_acl_right_unknown"; readonly detail: string; readonly unknown: readonly string[] }

const VALID_TARGETS = new Set<string>(Object.keys(INHERIT_FLAGS))

/**
 * Reject anything the matrix does not know, HOST-SIDE.
 *
 * An unknown right, operation or target must never reach the helper: passing it
 * on would mean the OS is asked to interpret a value no measurement stands
 * behind, and a typo would become a silently different grant. This runs before
 * any durable intent is written and before any OS mutation, so a rejected plan
 * leaves the machine — and the journal — untouched.
 *
 * Aliases are expanded first, so `modify` is checked as the explicit rights it
 * stands for rather than waved through as a level name.
 */
export function validateAclPlan(grants: readonly AclGrantRequest[]): AclPlanVerdict {
  const unknown: string[] = []
  const resolved: AclGrantRequest[] = []
  let mask = 0

  for (const g of grants) {
    if (!rowFor(g.operation)) unknown.push(`operation:${g.operation}`)
    if (!VALID_TARGETS.has(g.target)) unknown.push(`target:${g.target}`)
    const named = expandAlias(g.namedRights)
    for (const n of named) if (!(n in NAMED_RIGHTS)) unknown.push(`right:${n}`)
    // The matrix decides which target an operation may use; a known right on the
    // wrong object is still a grant nobody measured.
    const row = rowFor(g.operation)
    if (row && VALID_TARGETS.has(g.target) && row.target !== g.target) {
      unknown.push(`target_for_operation:${g.operation}:${g.target}`)
    }
    resolved.push({ ...g, namedRights: named })
    if (unknown.length === 0) mask |= maskOf(named)
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      reasonCode: "windows_acl_right_unknown",
      detail:
        `the ACL plan names values no measurement stands behind: ${[...new Set(unknown)].join(", ")}. ` +
        `Nothing was written to the journal, no container was created and no ACL was touched.`,
      unknown: [...new Set(unknown)],
    }
  }
  return { ok: true, mask: mask >>> 0, resolved }
}
