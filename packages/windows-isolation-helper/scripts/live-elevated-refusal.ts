/**
 * P5c2-FINAL-RC §2C — THE SEPARATE LIVE ELEVATED PROOF.
 *
 * Proves, against a genuinely elevated Windows token, that the production
 * isolation path refuses before it creates anything.
 *
 * WHY THIS IS NOT A TEST IN THE SUITE
 * ───────────────────────────────────
 * It used to be: `test/production-e2e.test.ts` carried a case named "the
 * ELEVATED production path refuses before creating anything" that called
 * `verifyHelperTrust` with no seam and asserted `elevated_host_not_supported`.
 * That silently made the whole authoritative suite elevated-only — from a
 * medium-integrity shell the very same assertion fails, because `elevated` is
 * genuinely `false` and trust is genuinely granted.
 *
 * The authoritative round runs at MEDIUM integrity, so this proof cannot be in
 * it. The tempting alternative — leave it in and let it skip — is worse than
 * leaving it out: a skipped test reports as a green suite while proving nothing,
 * and "the elevated path refuses" would then be an unproven claim that LOOKS
 * proven. So it lives here, and it REFUSES TO RUN unless the host is really
 * elevated. It never skips, never passes vacuously, and is reported separately.
 *
 * The three classes are documented together in the header of
 * `test/production-e2e.test.ts`:
 *   A live medium proof (in the suite)  ·  B deterministic policy proof (in the
 *   suite)  ·  C this file (elevated shell only, outside the suite).
 *
 *   From an ELEVATED shell:  bun scripts/live-elevated-refusal.ts
 *
 * Exit 0 = the live elevated refusal is proven. Exit 2 = wrong environment
 * (not elevated), which is NOT a pass. Exit 1 = the proof failed.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { createAppContainerBackend, verifyHelperTrust } from "../src/backend"
import { ElevatedHostNotSupported, REQUIRED_PROTOCOL_VERSION, directHelperRunner } from "../src/helper-runner"
import { runAggregateId } from "../src/journal"
import { executeRun, profileDirFor, profileNameFor } from "../src/lifecycle"

/** The ownership prefix every artefact this package creates carries. */
const OWNERSHIP_PREFIX = "abdo-winiso-"

const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
const MANIFEST = join(import.meta.dir, "..", "helper-manifest.json")
const CMD = "C:\\Windows\\System32\\cmd.exe"

const log = (m: string) => console.log(`[C-live-elevated] ${m}`)
const failures: string[] = []
function check(what: string, cond: boolean, detail = ""): void {
  if (cond) log(`OK   ${what}`)
  else {
    log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`)
    failures.push(what)
  }
}

/** The helper's own measurement of this process's token. Never assumed. */
function selfReportDirect(): Record<string, unknown> {
  const p = Bun.spawnSync([HELPER, "version"], { stdout: "pipe", stderr: "pipe", timeout: 90_000 })
  const out = p.stdout.toString().trim()
  try {
    return JSON.parse(out.split("\n").at(-1) ?? "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}

if (process.platform !== "win32") {
  log("REFUSING: not win32. This proof is Windows-only.")
  process.exit(2)
}
if (!existsSync(HELPER)) {
  log(`REFUSING: the helper is not built at ${HELPER}. Run build.ps1 first.`)
  process.exit(2)
}

// ── THE ENVIRONMENT GATE. Wrong environment is exit 2, never a pass. ────────
const self = selfReportDirect()
log(`token: elevated=${self.elevated} integrity=${self.integrity} rid=${self.integrityRid} protocol=${self.protocolVersion}`)
if (self.elevated !== true) {
  log("REFUSING TO RUN: this shell is NOT elevated, so there is no live elevated refusal to measure.")
  log("This is NOT a pass and must never be recorded as one. Re-run from an elevated shell.")
  process.exit(2)
}
if (self.integrityRid !== 12288) {
  log(`REFUSING TO RUN: expected a HIGH integrity token (RID 12288), measured ${String(self.integrityRid)}.`)
  process.exit(2)
}

check("the live token is elevated", self.elevated === true)
check("the live token is high integrity (RID 12288)", self.integrityRid === 12288, `integrity=${String(self.integrity)}`)
check(`the live helper speaks protocol v${REQUIRED_PROTOCOL_VERSION}`, self.protocolVersion === REQUIRED_PROTOCOL_VERSION, `got v${String(self.protocolVersion)}`)

// ── 1. THE UNSEAMED PRODUCTION TRUST CHECK REFUSES. ────────────────────────
//
// No injected selfReport: `verifyHelperTrust` spawns the helper itself and sees
// this elevated token.
const trust = verifyHelperTrust(HELPER, MANIFEST)
check("the unseamed production path is NOT trusted", trust.trusted === false)
check("the refusal reason is elevated_host_not_supported", trust.reasonCode === "elevated_host_not_supported", `got ${String(trust.reasonCode)}`)
check("the refusal reports elevated=true", trust.elevated === true)

// It refused on the POLICY, not on stale evidence — the identity checks were all
// reached and passed first, and the elevation branch is the only refusal that
// carries the hash, protocol, source hash and toolchain through.
check("it is not a stale_isolation_evidence refusal in disguise", trust.reasonCode !== "stale_isolation_evidence")
check("the binary hash was established before the policy fired", /^[0-9a-f]{64}$/.test(trust.binaryHash), `binaryHash=${trust.binaryHash}`)
check("the protocol was established before the policy fired", trust.protocolVersion === REQUIRED_PROTOCOL_VERSION)
check("the manifest source hash was established", /^[0-9a-f]{64}$/.test(trust.manifestSourceHash))
check("the toolchain identity was established", trust.toolchain === "stable-x86_64-pc-windows-gnu", `toolchain=${trust.toolchain}`)
check("the manifest agrees with the binary on disk", trust.binaryHash === String(self.binaryHash))

// ── 2. ZERO MUTATION: the backend refuses without starting the helper. ─────
const runId = `c-live-elevated-${process.pid}`
const cwd = mkdtempSync(join(tmpdir(), "abdo-c-elev-"))
let helperInvocations = 0
try {
  const backend = createAppContainerBackend({
    store: new MemoryEventStore(),
    helperPath: HELPER,
    manifestPath: MANIFEST,
    // NO selfReport: the live elevated token is what is under test.
    // IF THIS RUNS, THE PROOF HAS FAILED.
    helper: async () => {
      helperInvocations++
      throw new Error("the helper must never be started on an elevated host")
    },
  })

  const res = await backend.run({
    runId,
    executable: CMD,
    argv: ["/c", "echo", "must-not-run"],
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 30_000,
  })

  check("the backend refused", res.ok === false)
  check("the backend's reason is elevated_host_not_supported", res.reasonCode === "elevated_host_not_supported", `got ${String(res.reasonCode)}`)
  check("no child was started", res.childStarted === false)
  check("no exit code was produced", res.exitCode === null)
  check("no applied evidence was emitted at all", res.appliedEvidence === undefined)

  // ZERO MUTATION. `helperInvocations === 0` also covers the execution root:
  // the root is resolved through the helper's own `known-folder` call
  // (`src/execution-root.ts:307`), never from `%ProgramData%`, so a helper that
  // was never invoked cannot have created or bound one.
  check("the helper was never invoked", helperInvocations === 0, `invocations=${helperInvocations}`)
  check("no AppContainer profile was created for this run", !existsSync(profileDirFor(profileNameFor(runId))))
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

// ── 3. THE MUTATING COMMAND REFUSES WITHOUT PERFORMING IT. ────────────────
//
// MOVED HERE from `test/invariants.test.ts` §9, where it opened with
// `if (!selfElevated()) return` and therefore counted as a PASS at medium
// integrity while asserting nothing.
//
// THE DEFECT IT PINS: the elevation check used to run on the way OUT — spawn,
// parse, then inspect `elevated`. For `ensure-profile`, the lifecycle's first
// helper call, that means an elevated host CREATED A REAL PROFILE and only then
// refused, leaving a container no journal entry describes.
{
  const name = `${OWNERSHIP_PREFIX}elev-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  const run = directHelperRunner(HELPER)
  let refused: unknown
  try {
    await run({ argv: ["ensure-profile", "--name", name] })
  } catch (e) {
    refused = e
  }
  check("ensure-profile is refused as ElevatedHostNotSupported", refused instanceof ElevatedHostNotSupported, `got ${refused === undefined ? "no refusal at all" : String(refused)}`)
  // The decisive assertion: NOTHING was created on the way to refusing.
  const inspected = Bun.spawnSync([HELPER, "inspect-profile", "--name", name], { stdout: "pipe", stderr: "pipe", timeout: 90_000 })
  let profileExists: unknown = "unreadable"
  try {
    profileExists = (JSON.parse(inspected.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>).profileExists
  } catch {
    /* left as "unreadable" */
  }
  check("no profile was created on the way to refusing", profileExists === false, `profileExists=${String(profileExists)}`)
  check("no profile directory exists on disk", !existsSync(profileDirFor(name)))
}

// ── 4. THE LIFECYCLE REFUSES BEFORE WRITING A SINGLE JOURNAL EVENT. ───────
//
// Also moved from `test/invariants.test.ts` §9, same reason.
{
  const store = new MemoryEventStore()
  const id = `elevlc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  let refused: unknown
  try {
    await executeRun(
      { store, helper: directHelperRunner(HELPER), helperBinaryHash: String(self.binaryHash ?? ""), helperProtocolVersion: REQUIRED_PROTOCOL_VERSION },
      { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000 },
    )
  } catch (e) {
    refused = e
  }
  check("the lifecycle is refused as ElevatedHostNotSupported", refused instanceof ElevatedHostNotSupported, `got ${refused === undefined ? "no refusal at all" : String(refused)}`)
  // Not even an intent: the policy decision precedes the journal.
  const events = await store.read("project", runAggregateId(id))
  check("not a single journal event was written", events.length === 0, `events=${events.length}`)
}

// ── report ─────────────────────────────────────────────────────────────────
log("")
if (failures.length === 0) {
  log(`RESULT: LIVE ELEVATED REFUSAL PROVEN (elevated=true, integrity=${String(self.integrity)}, rid=${String(self.integrityRid)}, zero mutation)`)
  process.exit(0)
}
log(`RESULT: FAILED — ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`)
process.exit(1)
