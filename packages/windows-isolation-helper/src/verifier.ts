/**
 * CL-16A2-C §9 — helper trust and TOCTOU verifier.
 *
 * STANDALONE ON PURPOSE. This slice does NOT wire it to the runtime: the spike
 * has to establish what a future integration would have to verify before
 * trusting the helper binary, and a verifier that is already load-bearing cannot
 * be evaluated on its own. It exports the reason code the production launcher
 * would raise — `stale_isolation_evidence` — but nothing imports it yet.
 *
 * The threat is simple and it is the one CL-11 kept finding: a decision is taken
 * against a helper that was measured, and a DIFFERENT helper runs. So identity
 * is not "the path exists" — it is source hash, binary hash, protocol version,
 * toolchain, and the resolved real path, all pinned at decision time and
 * re-derived immediately before use.
 */
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"

/**
 * Must track the helper's own `PROTOCOL_VERSION` (src/main.rs).
 *
 * It did not, and seven identity tests failed at once: the helper moved to v2
 * for CL-16A2-D's narrow operations while this stayed at v1, so every check
 * tripped the version guard before reaching the tamper/substitution case it was
 * written to prove. A version constant duplicated in two languages needs a test
 * that compares them, which `harness-invariants.test.ts` now does.
 */
export const HELPER_PROTOCOL_VERSION = 10

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

/** What a decision pins. Every field is re-derived before the helper is used. */
export interface HelperIdentity {
  readonly helperPath: string
  /** `realpathSync` of the path — a junction/symlink swap changes this. */
  readonly helperRealPath: string
  readonly helperBinaryHash: string
  readonly helperBinaryBytes: number
  readonly helperSourceHash: string
  readonly helperProtocolVersion: number
  readonly rustToolchainIdentity: string
  readonly supportedOSBuild: string
  readonly capabilityEvidenceHash: string
}

export interface HelperManifest {
  readonly helperSourceHash: string
  readonly helperBinaryHash: string
  readonly helperProtocolVersion: number
  readonly rustToolchainIdentity: string
  readonly supportedOSBuild: string
}

/**
 * Read the identity of the helper AS IT IS ON DISK RIGHT NOW.
 *
 * `helperSourceHash` and the toolchain come from the build manifest, which is a
 * CLAIM; the binary hash is a MEASUREMENT. Comparing the two is the point of
 * `verifyHelper` — a manifest that describes a different binary is precisely the
 * source/binary mismatch this has to catch.
 */
export function readHelperIdentity(helperPath: string, manifest: HelperManifest, capabilityEvidenceHash: string): HelperIdentity {
  const bytes = readFileSync(helperPath)
  return {
    helperPath,
    helperRealPath: realpathSync(helperPath),
    helperBinaryHash: sha256(bytes),
    helperBinaryBytes: statSync(helperPath).size,
    helperSourceHash: manifest.helperSourceHash,
    helperProtocolVersion: manifest.helperProtocolVersion,
    rustToolchainIdentity: manifest.rustToolchainIdentity,
    supportedOSBuild: manifest.supportedOSBuild,
    capabilityEvidenceHash,
  }
}

export type HelperVerdict =
  | { readonly ok: true; readonly identity: HelperIdentity }
  | { readonly ok: false; readonly reasonCode: string; readonly detail: string; readonly moved: readonly string[] }

/**
 * Re-verify the helper against what the decision pinned. Anything that moved is
 * `stale_isolation_evidence`; the helper is NOT run.
 */
export function verifyHelper(pinned: HelperIdentity, now: HelperIdentity, expectedProtocol = HELPER_PROTOCOL_VERSION): HelperVerdict {
  if (now.helperProtocolVersion !== expectedProtocol) {
    return {
      ok: false,
      reasonCode: "helper_protocol_version_mismatch",
      detail: `the helper speaks v${now.helperProtocolVersion}; this caller speaks v${expectedProtocol}`,
      moved: ["helperProtocolVersion"],
    }
  }
  const moved = (Object.keys(pinned) as (keyof HelperIdentity)[]).filter((k) => pinned[k] !== now[k])
  if (moved.length > 0) {
    return {
      ok: false,
      reasonCode: "stale_isolation_evidence",
      detail: `the helper changed between the decision and its use: ${moved.join(", ")}; nothing was executed`,
      moved,
    }
  }
  return { ok: true, identity: now }
}

/**
 * A symlink or junction standing where the helper should be.
 *
 * Reported separately from a hash mismatch because it is a different fact: the
 * bytes may be identical today and different in a second, and a redirection at
 * the path is worth refusing on its own rather than trusting a hash taken
 * through it.
 */
export function isRedirected(helperPath: string): boolean {
  try {
    const l = lstatSync(helperPath)
    if (l.isSymbolicLink()) return true
    // A junction reports as a directory-ish reparse point; comparing the
    // resolved path catches both without needing the reparse tag.
    return realpathSync(helperPath).toLowerCase() !== helperPath.toLowerCase()
  } catch {
    return true // unreadable is not trustworthy
  }
}
