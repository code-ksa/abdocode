/**
 * CL-16A3-B2B §1 — the rights matrix, and the invariants that keep it honest.
 *
 * The most valuable test here is the CROSS-LANGUAGE one: the named-right masks
 * live in both `acl.rs` and `windows-acl-matrix.ts`, and a duplicated constant is
 * a constant that will disagree with itself. This slice has already been bitten
 * twice by exactly that (helper v2 vs verifier v1; `helperProtocolVersion` typed
 * as a literal in build.ps1), so the values are compared rather than trusted.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  expandAlias,
  FORBIDDEN_MASK_BITS,
  INHERIT_FLAGS,
  maskOf,
  NAMED_RIGHTS,
  RIGHT_BITS,
  RIGHTS_EVIDENCE_VERSION,
  RIGHTS_MODEL_VERSION,
  rightsPlanHash,
  rowFor,
  WINDOWS_ACL_MATRIX,
} from "../src/windows-acl-matrix"

const ACL_RS = join(import.meta.dir, "..", "..", "windows-isolation-helper", "src", "acl.rs")

describe("CL-16A3-B2B section 1 - the matrix agrees with the helper", () => {
  test("every RIGHT_BITS value equals the constant in acl.rs", () => {
    const rs = readFileSync(ACL_RS, "utf8")
    const pairs: [keyof typeof RIGHT_BITS, string][] = [
      ["FILE_READ_DATA_OR_LIST", "FILE_READ_DATA_OR_LIST"],
      ["FILE_WRITE_DATA_OR_ADD_FILE", "FILE_WRITE_DATA_OR_ADD_FILE"],
      ["FILE_APPEND_OR_ADD_SUBDIR", "FILE_APPEND_OR_ADD_SUBDIR"],
      ["FILE_READ_EA", "FILE_READ_EA"],
      ["FILE_WRITE_EA", "FILE_WRITE_EA"],
      ["FILE_EXECUTE_OR_TRAVERSE", "FILE_EXECUTE_OR_TRAVERSE"],
      ["FILE_DELETE_CHILD", "FILE_DELETE_CHILD"],
      ["FILE_READ_ATTRIBUTES", "FILE_READ_ATTRIBUTES_RIGHT"],
      ["FILE_WRITE_ATTRIBUTES", "FILE_WRITE_ATTRIBUTES"],
      ["DELETE", "RIGHT_DELETE"],
      ["READ_CONTROL", "RIGHT_READ_CONTROL"],
      ["SYNCHRONIZE", "RIGHT_SYNCHRONIZE"],
    ]
    for (const [tsName, rsName] of pairs) {
      const m = new RegExp(`pub const ${rsName}: DWORD = (0x[0-9A-Fa-f_]+);`).exec(rs)
      expect(m, `${rsName} not found in acl.rs`).toBeTruthy()
      const rsValue = Number(m![1]!.replace(/_/g, ""))
      expect(rsValue, `${tsName} disagrees with ${rsName}`).toBe(RIGHT_BITS[tsName])
    }
  })

  test("the inheritance flags equal acl.rs target_flags", () => {
    const rs = readFileSync(ACL_RS, "utf8")
    // object_self must be NO_INHERITANCE, and the ACE header bits must match.
    expect(rs).toContain("pub const OBJECT_INHERIT_ACE: DWORD = 0x1;")
    expect(rs).toContain("pub const CONTAINER_INHERIT_ACE: DWORD = 0x2;")
    expect(rs).toContain("pub const NO_PROPAGATE_INHERIT_ACE: DWORD = 0x4;")
    expect(rs).toContain("pub const INHERIT_ONLY_ACE: DWORD = 0x8;")
    expect(INHERIT_FLAGS.object_self).toBe(0)
    expect(INHERIT_FLAGS.descendants).toBe(0x1 | 0x2 | 0x8)
    expect(INHERIT_FLAGS.immediate_children & 0x4).toBe(0x4)
  })

  test("every named right in the matrix exists in acl.rs named_right", () => {
    const rs = readFileSync(ACL_RS, "utf8")
    const named = new Set(WINDOWS_ACL_MATRIX.flatMap((r) => r.namedRights))
    for (const n of named) expect(rs, `acl.rs has no "${n}" right`).toContain(`"${n}" =>`)
  })
})

describe("CL-16A3-B2B section 1 - the matrix is least-privilege by construction", () => {
  test("NO row requests Full Control, GENERIC_*, WRITE_DAC or WRITE_OWNER", () => {
    for (const r of WINDOWS_ACL_MATRIX) {
      expect(r.mask & FORBIDDEN_MASK_BITS, `${r.operation} asks for a forbidden bit`).toBe(0)
    }
  })

  test("ancestor traverse grants NEITHER listing NOR reading", () => {
    // The row the whole execution-root design rests on.
    const t = rowFor("ancestor_traverse")!
    expect(t.target).toBe("object_self")
    expect(t.mask & RIGHT_BITS.FILE_READ_DATA_OR_LIST).toBe(0)
    expect(t.mask & RIGHT_BITS.FILE_EXECUTE_OR_TRAVERSE).toBe(RIGHT_BITS.FILE_EXECUTE_OR_TRAVERSE)
    // The exact mask measured by the helper.
    expect(t.mask >>> 0).toBe(0x001000a0)
  })

  test("file read does NOT imply directory enumeration", () => {
    // On a directory these are the same bit, which is why read is granted on the
    // FILE and the directory gets traverse only.
    const read = rowFor("file_read")!
    const list = rowFor("directory_enumeration")!
    expect(read.objectType).toBe("file")
    expect(list.objectType).toBe("directory")
    expect(rowFor("ancestor_traverse")!.mask & RIGHT_BITS.FILE_READ_DATA_OR_LIST).toBe(0)
  })

  test("enumeration is optional, and it leaks nothing", () => {
    const list = rowFor("directory_enumeration")!
    expect(list.requirement).toBe("optional")
    expect(list.mask & RIGHT_BITS.FILE_WRITE_DATA_OR_ADD_FILE).toBe(0)
    expect(list.mask & RIGHT_BITS.DELETE).toBe(0)
    expect(list.mask & RIGHT_BITS.FILE_DELETE_CHILD).toBe(0)
  })

  test("the two delete paths are distinct rows with distinct objects", () => {
    const viaObject = rowFor("delete_file_via_object_delete")!
    const viaParent = rowFor("delete_file_via_parent")!
    expect(viaObject.objectType).toBe("file")
    expect(viaObject.mask & RIGHT_BITS.DELETE).toBe(RIGHT_BITS.DELETE)
    expect(viaParent.objectType).toBe("directory")
    expect(viaParent.mask & RIGHT_BITS.FILE_DELETE_CHILD).toBe(RIGHT_BITS.FILE_DELETE_CHILD)
    // Measured: delete_child as INHERIT_ONLY does NOT grant deletion, so this
    // row must be object_self and nothing else.
    expect(viaParent.target).toBe("object_self")
  })

  test("every row carries its evidence version", () => {
    for (const r of WINDOWS_ACL_MATRIX) {
      expect(r.evidenceVersion).toBe(RIGHTS_EVIDENCE_VERSION)
      expect(r.denialError).toBe(5) // ACCESS_DENIED, as measured
    }
  })
})

describe("CL-16A3-B2B section 1 - aliases never survive into a decision", () => {
  test("modify and rx expand to explicit named rights", () => {
    expect(expandAlias(["modify"])).not.toContain("modify")
    expect(expandAlias(["rx"])).not.toContain("rx")
    expect(expandAlias(["modify"])).toContain("write_file")
    expect(expandAlias(["rx"])).toContain("read_file")
  })

  test("expansion is idempotent and sorted, so a hash is stable", () => {
    const once = expandAlias(["modify", "traverse"])
    expect(expandAlias(once)).toEqual(once)
    expect([...once].sort()).toEqual(once)
  })

  test("an unknown name is passed through, so it fails loudly at the helper", () => {
    // Silently dropping it would turn a typo into a weaker grant.
    expect(expandAlias(["not_a_right"])).toEqual(["not_a_right"])
  })
})

describe("CL-16A3-B2B section 1 - the plan hash binds the matrix", () => {
  test("the hash is stable and version-bearing", () => {
    expect(rightsPlanHash()).toBe(rightsPlanHash())
    expect(RIGHTS_MODEL_VERSION).toBe(1)
  })

  test("changing ANY row changes the hash", () => {
    const base = rightsPlanHash()
    const altered = WINDOWS_ACL_MATRIX.map((r) => (r.operation === "file_read" ? { ...r, target: "descendants" as const } : r))
    expect(rightsPlanHash(altered)).not.toBe(base)
    const wider = WINDOWS_ACL_MATRIX.map((r) => (r.operation === "ancestor_traverse" ? { ...r, mask: maskOf(["read_file", "traverse"]) } : r))
    expect(rightsPlanHash(wider)).not.toBe(base)
  })

  test("maskOf always includes SYNCHRONIZE", () => {
    for (const n of Object.keys(NAMED_RIGHTS)) expect(maskOf([n]) & RIGHT_BITS.SYNCHRONIZE).toBe(RIGHT_BITS.SYNCHRONIZE)
  })
})
