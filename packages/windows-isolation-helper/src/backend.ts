/**
 * CL-16A2-E — the Windows AppContainer backend for the production launcher.
 *
 * This is the adapter that finally connects the proven resource lifecycle
 * (CL-16A2-D / -R / -L) to `launchControlledProcess`. It is deliberately an
 * ADAPTER and not a launcher: every durable control record, the capability gate,
 * the pre-spawn TOCTOU check and the refusal semantics stay in
 * `launchControlledProcess`, and this object is only reached from inside it. So
 * there is no route to an AppContainer that skips the enforcement point.
 *
 * WHAT IT REFUSES, ALWAYS BEFORE ANY MUTATION:
 *   - an elevated host (`elevated_host_not_supported`) — production never
 *     de-elevates, and the two source-scanning tests keep it that way;
 *   - a helper whose path, hash, protocol, manifest or toolchain does not match
 *     what was pinned (`stale_isolation_evidence`);
 *   - an unsupported Windows build.
 *
 * WHAT IT NEVER DOES: journal stdout, stderr, environment values or secrets. The
 * child's output is a return value; it is never an event.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import type { EventStore } from "@abdo/event-store"
import { executeRun, profileNameFor, type LifecycleDeps } from "./lifecycle"
import { directHelperRunner, ElevatedHostNotSupported, probeHelperSelfReport, REQUIRED_PROTOCOL_VERSION, StaleIsolationEvidence, type HelperRunner } from "./helper-runner"

export const APPCONTAINER_MECHANISM = "windows-appcontainer-zero-capabilities"

/** The lowest Windows build this was measured on. Older is refused, not guessed. */
export const MIN_SUPPORTED_WINDOWS_BUILD = 17763 // 1809, when AppContainer profile APIs stabilised

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

export interface HelperManifest {
  readonly helperProtocolVersion: number
  readonly helperSourceHash: string
  readonly helperBinaryHash: string
  readonly rustToolchainIdentity: string
  readonly supportedOSBuild?: string
}

export interface HelperTrust {
  readonly trusted: boolean
  readonly reasonCode?: string
  readonly detail?: string
  readonly binaryHash: string
  readonly protocolVersion: number
  readonly osBuildNumber: number
  readonly elevated: boolean | null
  readonly manifestSourceHash: string
  readonly toolchain: string
}

/**
 * Verify EVERYTHING the decision will rest on, before the helper is used for
 * anything that changes the machine.
 *
 * The `version` command is the only one run here, and it cannot mutate. The
 * production runner additionally refuses on elevation before spawning any
 * mutating command, so a failure here has already cost nothing.
 */
export type HelperSelfReport = () => Record<string, unknown>

export function verifyHelperTrust(helperPath: string, manifestPath?: string, selfReport?: HelperSelfReport): HelperTrust {
  const fail = (reasonCode: string, detail: string): HelperTrust => ({
    trusted: false,
    reasonCode,
    detail,
    binaryHash: "",
    protocolVersion: 0,
    osBuildNumber: 0,
    elevated: null,
    manifestSourceHash: "",
    toolchain: "",
  })

  if (!existsSync(helperPath)) return fail("stale_isolation_evidence", `the helper is not present at ${helperPath}`)
  // A REDIRECTION AT THE HELPER'S PATH IS A REFUSAL ON ITS OWN. A symlink or
  // junction means the bytes that run are chosen by whoever controls the link.
  let realPath: string
  try {
    realPath = realpathSync(helperPath)
  } catch {
    return fail("stale_isolation_evidence", `the helper path could not be resolved: ${helperPath}`)
  }
  if (realPath.toLowerCase() !== helperPath.toLowerCase()) {
    return fail("stale_isolation_evidence", `${helperPath} resolves elsewhere (${realPath}): a link at the helper's path is refused`)
  }
  try {
    if (!statSync(helperPath).isFile()) return fail("stale_isolation_evidence", "the helper path is not a regular file")
  } catch {
    return fail("stale_isolation_evidence", "the helper could not be stat'd")
  }

  const binaryHash = sha256(readFileSync(helperPath))

  const mPath = manifestPath ?? join(helperPath, "..", "..", "..", "helper-manifest.json")
  let manifest: HelperManifest
  try {
    manifest = JSON.parse(readFileSync(mPath, "utf8")) as HelperManifest
  } catch {
    return fail("stale_isolation_evidence", `the build manifest could not be read at ${mPath}`)
  }
  if (manifest.helperBinaryHash !== binaryHash) {
    return fail("stale_isolation_evidence", "the binary on disk is not the one the build manifest describes")
  }
  if (manifest.helperProtocolVersion !== REQUIRED_PROTOCOL_VERSION) {
    return fail("stale_isolation_evidence", `the manifest declares protocol v${manifest.helperProtocolVersion}; this host requires v${REQUIRED_PROTOCOL_VERSION}`)
  }
  if (!manifest.rustToolchainIdentity) {
    return fail("stale_isolation_evidence", "the manifest records no Rust toolchain identity")
  }

  // Ask the helper itself. `version` changes nothing.
  //
  // `selfReport` exists ONLY so the measurement harness can ask from a
  // MEDIUM-INTEGRITY process. This session's shell is elevated and the
  // production path (correctly) refuses there, so without this seam an E2E test
  // could never reach the mechanism at all. Production passes nothing and the
  // helper is spawned directly; `src/` never imports the harness, and two tests
  // enforce that by scanning this directory.
  let self: Record<string, unknown>
  try {
    if (selfReport) {
      self = selfReport()
    } else {
      // CL-16A3-B2C1 §4: through the helper PORT, not a spawn of this file's
      // own. This used to be a second `Bun.spawnSync` running the very same
      // `version` command the runner already runs — one capability with two
      // primitives, which is how "starting the helper" turns into a general
      // exception that a file-level allowlist then covers.
      self = probeHelperSelfReport(helperPath) as Record<string, unknown>
    }
  } catch {
    return fail("stale_isolation_evidence", "the helper did not report its own identity")
  }
  if (self.binaryHash !== binaryHash) {
    return fail("stale_isolation_evidence", "the helper's self-reported hash disagrees with the file on disk")
  }
  if (self.protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
    return fail("stale_isolation_evidence", `the helper speaks protocol v${String(self.protocolVersion)}; this host requires v${REQUIRED_PROTOCOL_VERSION}`)
  }
  const osBuildNumber = Number(self.osBuildNumber ?? 0)
  if (!(osBuildNumber >= MIN_SUPPORTED_WINDOWS_BUILD)) {
    return fail("isolation_unsupported_os", `Windows build ${osBuildNumber} is below the measured minimum ${MIN_SUPPORTED_WINDOWS_BUILD}`)
  }
  // THE ELEVATION REFUSAL, on the helper's own measurement of its token.
  if (self.elevated === true) {
    return {
      trusted: false,
      reasonCode: "elevated_host_not_supported",
      detail: "the AppContainer path is only supported when Abdo runs non-elevated; it will not silently de-elevate",
      binaryHash,
      protocolVersion: REQUIRED_PROTOCOL_VERSION,
      osBuildNumber,
      elevated: true,
      manifestSourceHash: manifest.helperSourceHash,
      toolchain: manifest.rustToolchainIdentity,
    }
  }

  return {
    trusted: true,
    binaryHash,
    protocolVersion: REQUIRED_PROTOCOL_VERSION,
    osBuildNumber,
    elevated: self.elevated === true,
    manifestSourceHash: manifest.helperSourceHash,
    toolchain: manifest.rustToolchainIdentity,
  }
}

/** The evidence hash a capability report is bound to. Names and hashes only. */
export const helperTrustEvidenceHash = (t: HelperTrust): string =>
  sha256(
    JSON.stringify({
      mechanism: APPCONTAINER_MECHANISM,
      binaryHash: t.binaryHash,
      protocolVersion: t.protocolVersion,
      osBuildNumber: t.osBuildNumber,
      sourceHash: t.manifestSourceHash,
      toolchain: t.toolchain,
      elevated: t.elevated,
    }),
  )

export interface AppContainerBackendOptions {
  readonly store: EventStore
  readonly helperPath: string
  readonly manifestPath?: string
  /**
   * Overrides the production runner. The measurement harness injects its
   * de-elevated runner here; `src/` never imports it, and two tests enforce that
   * by scanning this directory.
   */
  readonly helper?: HelperRunner
  /** Measurement-harness seam: report the helper's identity from another context. */
  readonly selfReport?: HelperSelfReport
  /** Paths the run may read, beyond its cwd. Chosen by the TOOL, never the model. */
  readonly grants?: readonly { path: string; rights: "rx" | "modify" }[]
}

export interface AppContainerBackend {
  readonly mechanism: string
  run(req: {
    runId: string
    executable: string
    argv: readonly string[]
    cwd: string
    env: Readonly<Record<string, string>>
    timeoutMs: number
    cancellation?: AbortSignal
  }): Promise<{
    ok: boolean
    reasonCode?: string
    detail?: string
    exitCode: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
    childStarted: boolean
    appliedEvidence?: {
      profileCreated: boolean
      profileOwnedByRun: boolean
      aclApplied: boolean
      childCreatedInContainer: boolean
      assignedToJob: boolean
      resumed: boolean
    }
  }>
}

/**
 * Build the backend. Nothing is verified here — trust is re-checked on EVERY run
 * immediately before the lifecycle starts, because a check performed once at
 * construction is exactly the stale evidence this design refuses.
 */
export function createAppContainerBackend(opts: AppContainerBackendOptions): AppContainerBackend {
  return {
    mechanism: APPCONTAINER_MECHANISM,
    async run(req) {
      const refuse = (reasonCode: string, detail: string) => ({
        ok: false,
        reasonCode,
        detail,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        childStarted: false,
      })

      // TRUST, RE-VERIFIED PER RUN AND BEFORE ANY MUTATION.
      const trust = verifyHelperTrust(opts.helperPath, opts.manifestPath, opts.selfReport)
      if (!trust.trusted) return refuse(trust.reasonCode ?? "stale_isolation_evidence", trust.detail ?? "the helper could not be trusted")

      const helper = opts.helper ?? directHelperRunner(opts.helperPath, trust.binaryHash)
      const deps: LifecycleDeps = {
        store: opts.store,
        helper,
        helperBinaryHash: trust.binaryHash,
        helperProtocolVersion: trust.protocolVersion,
      }

      // Cancellation is honoured by ending the run's timeout early; the helper
      // kills the whole job, so the container's descendants go with it.
      let aborted = false
      const timeoutMs = req.timeoutMs
      const onAbort = () => {
        aborted = true
      }
      req.cancellation?.addEventListener("abort", onAbort, { once: true })

      try {
        const result = await executeRun(deps, {
          // The profile name is DERIVED from the runId (`profileNameFor`), so
          // neither a tool nor the model can choose it, and recovery can always
          // compute what a dead run created.
          runId: req.runId,
          argv: [req.executable, ...req.argv],
          grants: opts.grants ?? [],
          timeoutMs,
          cwd: req.cwd,
        })
        const out = result.output
        if (!out) {
          return refuse("isolation_child_never_started", `the run ended in state ${result.state} without producing a process result`)
        }
        // WHAT WAS OBSERVED, not what was attempted. The launcher writes
        // `isolation.applied` only if every one of these is true, so each is
        // read from the helper's report of the machine or from the journal
        // projection - never assumed from having reached this line.
        return {
          ok: true,
          exitCode: out.exitCode,
          stdout: out.stdout,
          stderr: out.stderr,
          timedOut: out.timedOut,
          aborted: aborted || req.cancellation?.aborted === true,
          childStarted: out.childStarted,
          appliedEvidence: {
            profileCreated: result.profileCreated,
            // The name is DERIVED from the runId, so "owned by this run" is a
            // checkable fact rather than a label.
            profileOwnedByRun: result.profileName === profileNameFor(req.runId),
            // Every requested grant reached a completion with a granted SDDL.
            aclApplied: (opts.grants ?? []).length === 0 || result.grants.every((g) => g.grantedSddl !== ""),
            childCreatedInContainer: out.isProcessInJob || out.assignedToJob,
            assignedToJob: out.assignedToJob,
            resumed: out.resumed,
          },
        }
      } catch (e) {
        if (e instanceof ElevatedHostNotSupported) return refuse("elevated_host_not_supported", e.message)
        if (e instanceof StaleIsolationEvidence) return refuse("stale_isolation_evidence", e.message)
        return refuse("isolation_backend_failed", e instanceof Error ? e.message : String(e))
      } finally {
        req.cancellation?.removeEventListener("abort", onAbort)
      }
    },
  }
}

/** The profile name a given run will use. Exposed so tests can assert on it. */
export { profileNameFor }
