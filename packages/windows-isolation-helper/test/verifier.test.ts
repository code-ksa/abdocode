/**
 * CL-16A2-C section 9 — helper trust and TOCTOU, tested STANDALONE.
 *
 * The verifier is deliberately not wired to the runtime in this slice. What is
 * proven here is that it fires on each way a helper can be swapped between the
 * decision and its use, and that the reason code a future integration would
 * raise is `stale_isolation_evidence`.
 */
import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HELPER_PROTOCOL_VERSION, isRedirected, readHelperIdentity, verifyHelper, type HelperManifest } from "../src/verifier"

const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
const MANIFEST_PATH = join(import.meta.dir, "..", "helper-manifest.json")
const READY = process.platform === "win32" && existsSync(HELPER) && existsSync(MANIFEST_PATH)

const manifest = (): HelperManifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
const CAP = "cap-evidence-at-decision"

describe.skipIf(!READY)("helper identity", () => {
  test("the built binary matches the hash its own build manifest recorded", () => {
    // If this fails the manifest describes a different binary — the
    // source/binary mismatch the verifier exists to catch, in its most ordinary
    // form: someone rebuilt without re-running build.ps1.
    const id = readHelperIdentity(HELPER, manifest(), CAP)
    expect(id.helperBinaryHash).toBe(manifest().helperBinaryHash)
    expect(id.helperProtocolVersion).toBe(HELPER_PROTOCOL_VERSION)
  })

  test("an unchanged helper verifies", () => {
    const pinned = readHelperIdentity(HELPER, manifest(), CAP)
    const now = readHelperIdentity(HELPER, manifest(), CAP)
    expect(verifyHelper(pinned, now).ok).toBe(true)
  })

  test("a TAMPERED binary is refused as stale_isolation_evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-tamper-"))
    const copy = join(dir, "abdo-winiso.exe")
    copyFileSync(HELPER, copy)
    const pinned = readHelperIdentity(copy, manifest(), CAP)
    // One appended byte: enough to change the binary, not enough to look wrong.
    const bytes = readFileSync(copy)
    writeFileSync(copy, Buffer.concat([bytes, Buffer.from([0])]))
    const now = readHelperIdentity(copy, manifest(), CAP)
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("stale_isolation_evidence")
    expect(v.moved).toContain("helperBinaryHash")
    expect(v.moved).toContain("helperBinaryBytes")
  })

  test("a SOURCE/BINARY mismatch is refused even when the binary itself did not move", () => {
    const pinned = readHelperIdentity(HELPER, manifest(), CAP)
    const now = readHelperIdentity(HELPER, { ...manifest(), helperSourceHash: "0".repeat(64) }, CAP)
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toEqual(["helperSourceHash"])
  })

  test("a PROTOCOL VERSION mismatch has its own reason code", () => {
    const pinned = readHelperIdentity(HELPER, manifest(), CAP)
    // DERIVED, not a literal. A hard-coded sentinel silently stops testing a
    // mismatch the day the real protocol reaches that number; `+ 1` is a
    // different protocol by construction, whatever the current one is.
    const now = readHelperIdentity(HELPER, { ...manifest(), helperProtocolVersion: HELPER_PROTOCOL_VERSION + 1 }, CAP)
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    // Not folded into staleness: an older helper is a compatibility fact, and
    // saying "stale" would send a reader looking for a swap that never happened.
    expect(v.reasonCode).toBe("helper_protocol_version_mismatch")
  })

  test("a changed TOOLCHAIN identity is refused", () => {
    const pinned = readHelperIdentity(HELPER, manifest(), CAP)
    const now = readHelperIdentity(HELPER, { ...manifest(), rustToolchainIdentity: "stable-x86_64-pc-windows-msvc" }, CAP)
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toEqual(["rustToolchainIdentity"])
  })

  test("a changed CAPABILITY evidence hash is refused", () => {
    const pinned = readHelperIdentity(HELPER, manifest(), CAP)
    const now = readHelperIdentity(HELPER, manifest(), "cap-evidence-moved")
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toEqual(["capabilityEvidenceHash"])
  })

  test("SUBSTITUTION: a different file at the same path is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-swap-"))
    const path = join(dir, "abdo-winiso.exe")
    copyFileSync(HELPER, path)
    const pinned = readHelperIdentity(path, manifest(), CAP)
    writeFileSync(path, "MZ not really the helper at all")
    const now = readHelperIdentity(path, manifest(), CAP)
    const v = verifyHelper(pinned, now)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("stale_isolation_evidence")
  })

  test("the real helper path is not a redirection", () => {
    expect(isRedirected(HELPER)).toBe(false)
  })

  test("a path that does not exist counts as redirected, not as trustworthy", () => {
    expect(isRedirected(join(tmpdir(), "definitely-not-here-abdo-winiso.exe"))).toBe(true)
  })

  /**
   * CL-16A3-B2C1 §8 — no test may hard-code the protocol it claims to speak.
   *
   * Five fixtures carried `helperProtocolVersion: 2` (one carried `3`) while the
   * helper had moved to 7. That value is not decoration: the lifecycle records it
   * as DURABLE EVIDENCE on every event, so those journals asserted a protocol the
   * helper does not speak, and a test exercising a protocol nobody runs proves
   * nothing about the path it claims to cover. It went unnoticed because a
   * literal never goes stale loudly.
   *
   * The three protocol constants (Rust, verifier, helper-runner) already have a
   * cross-language agreement test. This closes the remaining hole: the FIXTURES.
   */
  test("no test fixture hard-codes a protocol number", () => {
    // WRITTEN BEFORE THE FIX, and it earned its keep immediately: it found a
    // SIXTH stale fixture (`fixtures/host-crash-child.ts`, the real-crash matrix
    // child) that the manual sweep had missed.
    // BOTH SPELLINGS. The first version matched only `helperProtocolVersion`,
    // and the protocol 8 -> 9 bump found what that missed: `isorun-recovery.test.ts`
    // hard-coded `protocolVersion: 8` — the key the HELPER's own envelope uses —
    // in six places, and sailed straight through a guard whose entire job was to
    // catch exactly that. A scanner that knows one of two names for one concept
    // is a scanner that reports clean while the hole is open.
    const PATTERN = /\bhelperProtocolVersion:\s*\d|(?<!helper)\bprotocolVersion:\s*\d/i
    // Comments AND string literals stripped, or this test reports itself: its
    // own prose describing the bug, and the non-vacuity assertion below that
    // must contain the offending shape as DATA, both look like fixtures to a
    // raw text scan. A real fixture is an object literal, never a string.
    const code = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    const scan = (dir: string, label: string, out: string[]) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) scan(join(dir, f.name), `${label}${f.name}/`, out)
        else if (f.name.endsWith(".ts")) {
          for (const [i, line] of code(readFileSync(join(dir, f.name), "utf8")).split(/\r?\n/).entries()) {
            // A bare number after the field. The DERIVED forms the mismatch
            // tests use (`HELPER_PROTOCOL_VERSION + 1`) are exactly what is wanted.
            if (PATTERN.test(line)) out.push(`${label}${f.name}:${i + 1}: ${line.trim()}`)
          }
        }
      }
    }
    const offenders: string[] = []
    scan(import.meta.dir, "", offenders)
    expect(offenders).toEqual([])
    // NON-VACUITY: the pattern really does catch the shape it claims to.
    expect(PATTERN.test("  helperProtocolVersion: 2,")).toBe(true)
    expect(PATTERN.test("  helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,")).toBe(false)
    // The spelling the six stale fixtures actually used.
    expect(PATTERN.test("  protocolVersion: 8,")).toBe(true)
    expect(PATTERN.test("  protocolVersion: REQUIRED_PROTOCOL_VERSION,")).toBe(false)
  })
})
