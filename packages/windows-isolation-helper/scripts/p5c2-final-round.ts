/**
 * P5c2-FINAL-RC §3 — THE ONE OFFICIAL RUNNER FOR THE ROUND.
 *
 * Replaces the hand-typed sequence of nine invocations that produced the
 * preliminary round. Manual invocation is not reproducible: the commands drift
 * between rounds, a gate gets run with a filter nobody recorded, and the
 * transcript becomes the only record of what was actually measured.
 *
 *   bun scripts/p5c2-final-round.ts [label]
 *
 * ## WHY THIS IS TYPESCRIPT AND NOT POWERSHELL
 *
 * MEASURED, not a preference. Windows PowerShell 5.1 corrupts exactly the two
 * things a round runner exists to record:
 *
 *   1. `2>&1` on a NATIVE executable wraps every stderr line in an ErrorRecord
 *      (NativeCommandError) and sets `$?` to false even when the process exited
 *      0. The preliminary round's own logs carry this damage — `gate1`,
 *      `gate2` and `gate3` all open with a PowerShell parse-error banner about
 *      the very command that succeeded.
 *   2. A pipeline (`| Tee-Object`, `| tail`) replaces the native exit code with
 *      the pipeline's, so a failing gate can read as a passing one. The
 *      checkpoint records this as a real incident: "A pipe destroys the exit
 *      code."
 *
 * `Bun.spawnSync` returns the child's true exit code and its streams verbatim.
 * So: FOREGROUND only, NO pipelines, NO tail, full output written to disk, and
 * the exit code read from the process rather than from a shell.
 *
 * ## THE RULES THIS ENCODES
 *
 * - Preflight must pass IN FULL before gate 1 is considered started. A wrong
 *   toolchain, an elevated shell, a manifest that disagrees with the binary, or
 *   pre-existing owned residue aborts the round with `gate1Started: false`.
 * - The nine gates run IN ORDER and the round STOPS at the first failure.
 * - The binary hash is recorded before gate 1 and again after the last gate. A
 *   round in which the artefact changed measured two different programs.
 * - Every gate's full stdout+stderr goes to its own file. Nothing is truncated,
 *   summarised or piped.
 * - pass/fail/skip/todo/ran are recorded per gate where the runner produces
 *   them, and a summary that does not add up is REFUSED rather than believed.
 * - Gate 8 must show that proof A actually RAN. A skipped A is not a pass.
 *
 * Exit 0 only if preflight passed, all nine gates passed, the binary hash was
 * unchanged end to end, and the final residue census is zero.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXPECTED_SKIPS } from "../test/gate8-expected-skips"

const PKG = join(import.meta.dir, "..")
const REPO = join(PKG, "..", "..")
const HELPER = join(PKG, "target", "release", "abdo-winiso.exe")
/** The hostile test fixture the authoritative security tests execute. */
const FIXTURE = join(PKG, "target", "release", "abdo-hostile-target.exe")
const MANIFEST = join(PKG, "helper-manifest.json")
const CARGO = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe")

/** Overridable ONLY so the wrong-toolchain preflight can be demonstrated. */
const TOOLCHAIN = process.env.P5C2_TOOLCHAIN ?? "stable-x86_64-pc-windows-gnu"
const EXPECTED_HOST = "x86_64-pc-windows-gnu"

const label = process.argv[2] ?? "p5c2-final-round"
const ARTIFACTS = join(REPO, "artifacts", label)
mkdirSync(ARTIFACTS, { recursive: true })

const started = Date.now()
const lines: string[] = []
function log(m: string): void {
  const s = `[${label}] ${m}`
  console.log(s)
  lines.push(s)
}

// ── measurement primitives ────────────────────────────────────────────────

async function sha256File(p: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256")
  h.update(new Uint8Array(await Bun.file(p).arrayBuffer()))
  return h.digest("hex")
}

/** The helper's own report of its identity and this process's token. */
function helperSelfReport(): Record<string, unknown> {
  const p = Bun.spawnSync([HELPER, "version"], { stdout: "pipe", stderr: "pipe", timeout: 90_000 })
  try {
    return JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}

interface Totals {
  pass: number
  fail: number
  skip: number
  todo: number
  ran: number
  files: number
}

/**
 * Read bun's own totals, or return undefined.
 *
 * DELIBERATELY NOT `test/suite-report.ts`: that parser breaks its backward walk
 * on any line it does not recognise, which is correct for the unfiltered suite
 * it guards but wrong here — a `-t`-filtered gate prints "N filtered out" INSIDE
 * the summary block, and the strict parser then reports "no pass line" for a
 * perfectly good run. The load-bearing cross-check is kept: pass + fail + skip +
 * todo must equal `ran`, or the totals are refused rather than reported.
 */
function parseTotals(output: string): { totals?: Totals; parseError?: string } {
  const ANSI = /\x1b\[[0-9;]*m/g
  const src = output.split(/\r?\n/).map((l) => l.replace(ANSI, ""))
  let ranIdx = -1
  for (let i = src.length - 1; i >= 0; i--) {
    if (/^Ran (\d+) tests? across (\d+) files?\./.test(src[i]!)) {
      ranIdx = i
      break
    }
  }
  if (ranIdx < 0) return { parseError: 'no "Ran N tests across M files." line: the run did not finish or its output was lost' }
  const m = /^Ran (\d+) tests? across (\d+) files?\./.exec(src[ranIdx]!)!
  const ran = Number(m[1])
  const files = Number(m[2])

  const counters = new Map<string, number>()
  for (let i = ranIdx - 1; i >= 0; i--) {
    const line = src[i]!
    const c = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/.exec(line)
    if (c) {
      counters.set(c[2]!, Number(c[1]))
      continue
    }
    // Part of the same block and NOT test counters.
    if (/^\s*\d+\s+expect\(\) calls\s*$/.test(line)) continue
    if (/^\s*\d+\s+filtered out\s*$/.test(line)) continue
    if (line.trim() === "") continue
    break
  }
  const pass = counters.get("pass")
  const fail = counters.get("fail")
  if (pass === undefined || fail === undefined) return { parseError: "the summary block has no pass/fail line" }
  const skip = counters.get("skip") ?? 0
  const todo = counters.get("todo") ?? 0
  const sum = pass + fail + skip + todo
  if (sum !== ran) {
    return { parseError: `the summary does not add up: ${pass}+${fail}+${skip}+${todo}=${sum} but bun ran ${ran}` }
  }
  return { totals: { pass, fail, skip, todo, ran, files } }
}

interface Census {
  helpers: number
  keepers: number
  hostiles: number
  profiles: number
  queues: number
  rootExists: boolean
  strayPing: number
}

/**
 * The execution root's parent, RESOLVED THROUGH THE HELPER (RC3 section 3B).
 *
 * This used to be the literal `'C:\ProgramData\Abdo'`, which
 * `windows-path-literals.test.ts` refuses and which failed the RC2 round. The
 * literal was wrong for a second reason beyond the lint: the production code
 * never reads `%ProgramData%` either, because an inherited variable is settable
 * by whoever launched the process. `src/execution-root.ts:307` asks the helper for
 * `SHGetKnownFolderPath(FOLDERID_ProgramData)`, so the census now asks the same
 * way and measures the directory the product would actually use.
 *
 * Returns undefined if the helper cannot answer; the caller then reports the root
 * as unknown rather than guessing a path.
 */
function executionRootParent(): string | undefined {
  const p = Bun.spawnSync([HELPER, "known-folder", "--id", "ProgramData"], { stdout: "pipe", stderr: "pipe", timeout: 90_000 })
  try {
    const j = JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
    if (j.ok !== true || typeof j.lexicalPath !== "string" || j.lexicalPath === "") return undefined
    return join(j.lexicalPath, "Abdo")
  } catch {
    return undefined
  }
}

/**
 * Count the owned residue. Uses the helper's siblings and the filesystem via
 * PowerShell, because process command lines (needed to tell a keeper from a
 * host) are not reachable from bun on Windows.
 */
function takeCensus(): { census: Census; raw: string } {
  // Passed as an ARGUMENT, never interpolated into the script text, so no
  // Windows path literal exists in this file for a backslash to be eaten from.
  const rootDir = executionRootParent() ?? ""
  const ps = String.raw`
param([string]$RootDir)
$ErrorActionPreference='SilentlyContinue'
$h=@(Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'")
$k=@($h | Where-Object { $_.CommandLine -like '*--job-keeper*' })
$t=@(Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe'")
$pr=@(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter 'abdo-winiso-*' -Directory)
$q=@(Get-ChildItem $env:TEMP -Directory -Filter 'abdo-winiso-harness-*')
$ping=@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'")
[pscustomobject]@{
  helpers=$h.Count; keepers=$k.Count; hostiles=$t.Count
  profiles=$pr.Count; queues=$q.Count
  rootExists=$(if ($RootDir -ne '') { Test-Path -LiteralPath $RootDir } else { $false })
  rootDir=$RootDir
  strayPing=$ping.Count
} | ConvertTo-Json -Compress
`
  const p = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps, "-RootDir", rootDir], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  const raw = p.stdout.toString().trim()
  try {
    const j = JSON.parse(raw.split("\n").at(-1) ?? "{}") as Record<string, unknown>
    return {
      census: {
        helpers: Number(j.helpers ?? -1),
        keepers: Number(j.keepers ?? -1),
        hostiles: Number(j.hostiles ?? -1),
        profiles: Number(j.profiles ?? -1),
        queues: Number(j.queues ?? -1),
        rootExists: j.rootExists === true,
        strayPing: Number(j.strayPing ?? -1),
      },
      raw,
    }
  } catch {
    return { census: { helpers: -1, keepers: -1, hostiles: -1, profiles: -1, queues: -1, rootExists: false, strayPing: -1 }, raw }
  }
}

const ownedResidue = (c: Census): number => c.helpers + c.keepers + c.hostiles + c.profiles + c.queues + c.strayPing + (c.rootExists ? 1 : 0)
const formatCensus = (c: Census) =>
  `helpers=${c.helpers}(keepers=${c.keepers}) hostiles=${c.hostiles} profiles=${c.profiles} queues=${c.queues} root=${c.rootExists} strayPing=${c.strayPing}`

// ── gate execution ────────────────────────────────────────────────────────

interface GateResult {
  n: string
  name: string
  cmd: string[]
  cwd: string
  exitCode: number | null
  durationSec: number
  logFile: string
  totals?: Totals
  parseError?: string
  status: "pass" | "fail"
  notes: string[]
}

const gates: GateResult[] = []
let firstFailure: string | undefined

/**
 * Run one gate in the FOREGROUND, capture everything, write it to disk whole.
 *
 * `extraCheck` runs only when the process exited 0; it is how a gate asserts on
 * its own output (e.g. "proof A must have RUN") rather than trusting a zero.
 */
function runGate(
  n: string,
  name: string,
  cmd: string[],
  cwd: string,
  opts: { readTotals?: boolean; extraCheck?: (out: string, totals?: Totals) => string[] } = {},
): GateResult {
  log("")
  log(`── GATE ${n}: ${name}`)
  log(`   cmd: ${cmd.join(" ")}`)
  log(`   cwd: ${cwd}`)
  const t0 = Date.now()
  // FOREGROUND, inherited nothing, no shell, no pipe. Exit code is the child's.
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const durationSec = Number(((Date.now() - t0) / 1000).toFixed(1))
  const out = p.stdout.toString() + p.stderr.toString()

  const logFile = join(ARTIFACTS, `gate${n}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`)
  writeFileSync(logFile, `$ ${cmd.join(" ")}\n$ cwd=${cwd}\n\n${out}\n\n=== GATE ${n} exitCode=${p.exitCode} durationSec=${durationSec} ===\n`, "utf8")

  const notes: string[] = []
  let totals: Totals | undefined
  let parseError: string | undefined
  if (opts.readTotals) {
    const r = parseTotals(out)
    totals = r.totals
    parseError = r.parseError
    if (parseError) notes.push(`TOTALS UNREADABLE: ${parseError}`)
  }

  let status: "pass" | "fail" = p.exitCode === 0 ? "pass" : "fail"
  // A zero exit with unreadable or empty totals is NOT a pass.
  if (status === "pass" && opts.readTotals) {
    if (!totals) status = "fail"
    else if (totals.fail > 0 || totals.ran === 0 || totals.pass === 0) {
      status = "fail"
      notes.push(`totals reject this run: fail=${totals.fail} ran=${totals.ran} pass=${totals.pass}`)
    }
  }
  if (status === "pass" && opts.extraCheck) {
    const problems = opts.extraCheck(out, totals)
    if (problems.length > 0) {
      status = "fail"
      notes.push(...problems)
    }
  }

  const g: GateResult = { n, name, cmd, cwd, exitCode: p.exitCode, durationSec, logFile, status, notes, ...(totals ? { totals } : {}), ...(parseError ? { parseError } : {}) }
  gates.push(g)
  log(`   exit=${p.exitCode} ${durationSec}s ${totals ? `· ${totals.pass} pass / ${totals.fail} fail / ${totals.skip} skip / ${totals.todo} todo / ${totals.ran} ran across ${totals.files} file(s)` : ""}`)
  for (const note of notes) log(`   ! ${note}`)
  log(`   -> ${status.toUpperCase()}  log: ${logFile}`)
  if (status === "fail" && !firstFailure) firstFailure = `gate ${n} (${name})`
  return g
}

// ══ PREFLIGHT ═════════════════════════════════════════════════════════════
//
// Nothing below counts as a gate. If any check fails the round ABORTS and
// records gate1Started=false, because a round that began on a wrong toolchain,
// an elevated token, a disagreeing manifest or a dirty machine never measured
// what it claims to.

log("═══ PREFLIGHT ═══")
const pf: { check: string; ok: boolean; detail: string }[] = []
const need = (check: string, ok: boolean, detail = "") => {
  pf.push({ check, ok, detail })
  log(`  ${ok ? "OK  " : "FAIL"} ${check}${detail ? ` — ${detail}` : ""}`)
}

need("platform is win32", process.platform === "win32", process.platform)
need("the helper is built", existsSync(HELPER), HELPER)
need("the manifest exists", existsSync(MANIFEST), MANIFEST)

// -- toolchain identity. THE WRONG-TOOLCHAIN ABORT LIVES HERE. --------------
const rustcProbe = Bun.spawnSync([CARGO, `+${TOOLCHAIN}`, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
need(`the toolchain ${TOOLCHAIN} is installed`, rustcProbe.exitCode === 0, rustcProbe.exitCode === 0 ? rustcProbe.stdout.toString().trim() : rustcProbe.stderr.toString().trim().slice(0, 200))
need(`the toolchain targets ${EXPECTED_HOST}`, TOOLCHAIN.includes(EXPECTED_HOST), `configured=${TOOLCHAIN}`)

let manifest: Record<string, unknown> = {}
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>
} catch (e) {
  need("the manifest parses", false, String(e))
}
need("the manifest's toolchain is the one being used", manifest.rustToolchainIdentity === TOOLCHAIN, `manifest=${String(manifest.rustToolchainIdentity)} configured=${TOOLCHAIN}`)

// -- identity agreement: disk, manifest, live helper ------------------------
//
// TWO ARTEFACTS ARE VERIFIED, NOT ONE (RC3 section 2). The helper is the trusted
// artefact, but the authoritative security tests EXECUTE `abdo-hostile-target.exe`
// — "a target inside an AppContainer cannot open its own keeper" is a claim about
// that specific program. A round that pinned only the helper would be measuring
// hostility with an unidentified adversary.
const diskHashBefore = existsSync(HELPER) ? await sha256File(HELPER) : ""
const fixtureHashBefore = existsSync(FIXTURE) ? await sha256File(FIXTURE) : ""
const self = helperSelfReport()
need("the on-disk binary matches the manifest hash", diskHashBefore !== "" && diskHashBefore === manifest.helperBinaryHash, `disk=${diskHashBefore.slice(0, 16)}… manifest=${String(manifest.helperBinaryHash).slice(0, 16)}…`)
need("the live helper reports the same hash", self.binaryHash === diskHashBefore, `live=${String(self.binaryHash).slice(0, 16)}…`)
need("the manifest declares protocol 10", manifest.helperProtocolVersion === 10, String(manifest.helperProtocolVersion))
need("the live helper speaks protocol 10", self.protocolVersion === 10, String(self.protocolVersion))

// -- artefact B: the hostile test fixture, pinned in its own right -----------
need("the hostile-target fixture is built", existsSync(FIXTURE), FIXTURE)
need(
  "the fixture on disk matches its manifest hash",
  fixtureHashBefore !== "" && fixtureHashBefore === manifest.hostileTargetBinaryHash,
  `disk=${fixtureHashBefore.slice(0, 16)}… manifest=${String(manifest.hostileTargetBinaryHash).slice(0, 16)}…`,
)
need("the fixture byte count matches the manifest", existsSync(FIXTURE) && statSync(FIXTURE).size === Number(manifest.hostileTargetBytes), `disk=${existsSync(FIXTURE) ? statSync(FIXTURE).size : -1} manifest=${String(manifest.hostileTargetBytes)}`)
need("the fixture records a source hash", /^[0-9a-f]{64}$/.test(String(manifest.hostileTargetSourceHash ?? "")), String(manifest.hostileTargetSourceHash).slice(0, 16))
need(
  "the fixture's source closure names hostile-target.rs",
  Array.isArray(manifest.hostileTargetSourceInputs) && (manifest.hostileTargetSourceInputs as string[]).includes("src/hostile-target.rs"),
  JSON.stringify(manifest.hostileTargetSourceInputs ?? null),
)
need("the fixture was built with the same toolchain", manifest.hostileTargetToolchain === TOOLCHAIN, `manifest=${String(manifest.hostileTargetToolchain)}`)
// The two artefacts must be DISTINCT programs. Equal hashes would mean the
// "hostile" target is the helper itself, and every containment test would be
// measuring the trusted binary against itself.
need("the fixture is not the helper", fixtureHashBefore !== "" && fixtureHashBefore !== diskHashBefore, `fixture=${fixtureHashBefore.slice(0, 16)}…`)

// -- the round's environment: medium integrity, non-elevated ----------------
need("the shell is NOT elevated", self.elevated === false, `elevated=${String(self.elevated)}`)
need("the token is medium integrity", self.integrity === "medium", `integrity=${String(self.integrity)}`)
need("the integrity RID is 8192", self.integrityRid === 8192, `rid=${String(self.integrityRid)}`)

// -- the machine starts clean ----------------------------------------------
const before = takeCensus()
log(`  census BEFORE: ${formatCensus(before.census)}`)
need("no owned residue before the round", ownedResidue(before.census) === 0, `residue=${ownedResidue(before.census)}`)

// -- provenance: what tree is being measured -------------------------------
const gitHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
const gitStatus = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
log(`  git HEAD: ${gitHead}`)
log(`  git dirty entries: ${gitStatus === "" ? 0 : gitStatus.split("\n").length}`)

const preflightOk = pf.every((c) => c.ok)
if (!preflightOk) {
  log("")
  log("═══ PREFLIGHT FAILED — THE ROUND DID NOT START ═══")
  log(`failed: ${pf.filter((c) => !c.ok).map((c) => c.check).join("; ")}`)
  log("GATE 1 WAS NOT STARTED. No gate result may be reported from this run.")
  const abort = {
    label,
    outcome: "preflight_failed",
    gate1Started: false,
    toolchain: TOOLCHAIN,
    preflight: pf,
    gates: [],
    gitHead,
    takenAtUtc: new Date().toISOString(),
  }
  writeFileSync(join(ARTIFACTS, "ROUND.json"), JSON.stringify(abort, null, 2), "utf8")
  writeFileSync(join(ARTIFACTS, "ROUND.log"), `${lines.join("\n")}\n`, "utf8")
  process.exit(2)
}
log("PREFLIGHT PASSED — gate 1 may start.")
log(`binary hash BEFORE gate 1: ${diskHashBefore}`)

// ══ THE NINE GATES, IN ORDER, STOPPING AT THE FIRST FAILURE ══════════════

const BUN = "bun"
const KEEPER_RACE = "test/keeper-race.test.ts"

function gate1(): void {
  runGate("1", "rust tests", [CARGO, `+${TOOLCHAIN}`, "test", "--bin", "abdo-winiso"], PKG, {
    extraCheck: (out) => (/test result: ok\./.test(out) ? [] : ['cargo did not print "test result: ok."']),
  })
}

function gate2(): void {
  // Package first, then from the ROOT across the whole `@abdo/*` workspace —
  // the package's own typecheck cannot see a break it causes in a sibling.
  //
  // `--force` is load-bearing: without it turbo reports "cache hit, replaying
  // logs" and the round would be quoting a typecheck performed on some earlier
  // day as though it had just measured it. Replayed evidence is exactly what
  // this package refuses everywhere else.
  //
  // ── A DOCUMENTED, PRE-EXISTING EXCLUSION ────────────────────────────────
  // The scope is `@abdo/*` (21 packages), NOT all 51. An unfiltered
  // `bun turbo typecheck` CANNOT be green on this tree, and not for any reason
  // P5c2 caused: `packages/app/src/custom-elements.d.ts` and
  // `packages/enterprise/src/custom-elements.d.ts` are each a 33-byte file whose
  // entire content is the text `../../ui/src/custom-elements.d.ts` — symlinks
  // that git checked out as PLAIN TEXT on this Windows machine, so tsgo parses a
  // path as TypeScript and reports TS1128. Both files are unmodified since the
  // fork commit 88f001c (2026-07-21), eight days before P5c2, and both are
  // vendored upstream abdo packages that the isolation helper neither
  // imports nor affects.
  //
  // This is stated rather than silently scoped: the round narrows gate 2 to the
  // workspace P5c2 owns, and the two failures above remain OPEN and unproven by
  // this round. Fixing them is a separate, unrelated piece of work.
  const a = runGate("2a", "package typecheck", [BUN, "run", "typecheck"], PKG)
  if (a.status !== "pass") return
  log("   note: gate 2b scope is @abdo/* (21 pkgs). packages/app + packages/enterprise are EXCLUDED —")
  log("         pre-existing TS1128 from symlinks checked out as text at fork commit 88f001c, unrelated to P5c2.")
  runGate("2b", "root abdo-workspace typecheck", [BUN, "turbo", "typecheck", "--filter=@abdo/*", "--force"], REPO, {
    extraCheck: (out) => {
      const m = /Tasks:\s+(\d+) successful, (\d+) total/.exec(out)
      if (!m) return ["turbo did not print its task summary"]
      if (m[1] !== m[2]) return [`only ${m[1]}/${m[2]} turbo tasks succeeded`]
      if (Number(m[2]) < 21) return [`expected at least 21 @abdo/* packages, turbo ran ${m[2]}`]
      const cached = /Cached:\s+(\d+) cached/.exec(out)
      if (cached && Number(cached[1]) > 0) return [`${cached[1]} task(s) were replayed from cache; --force did not take effect`]
      return []
    },
  })
}

function gate3(): void {
  runGate("3", "strict authorization matrix", [CARGO, `+${TOOLCHAIN}`, "test", "--bin", "abdo-winiso", "authmsg"], PKG, {
    extraCheck: (out) => (/test result: ok\./.test(out) ? [] : ['cargo did not print "test result: ok."']),
  })
}

function gate4(): void {
  runGate("4", "hostile keeper access", [BUN, "test", KEEPER_RACE, "-t", "the target cannot reach its own keeper"], PKG, { readTotals: true })
}

function gate5(): void {
  // THE COMPLETE matrix — the whole file, all three describes, no filter. Gate 4
  // is deliberately a subset of this: it isolates the hostile-access proof so a
  // failure there is attributable, and gate 5 then proves the matrix entire.
  runGate("5", "complete keeper race matrix", [BUN, "test", KEEPER_RACE], PKG, {
    readTotals: true,
    extraCheck: (_out, t) => (t && t.ran >= 11 ? [] : [`expected the complete matrix (>= 11 tests), ran ${t?.ran ?? "?"}`]),
  })
}

function gate6(): void {
  runGate("6", "isolated crash sweep", [BUN, "scripts/isolated-crash-sweep.ts", label], PKG, {
    extraCheck: (out) => {
      const m = /--- (\d+)\/(\d+) points clean ---/.exec(out)
      if (!m) return ["the sweep did not print its points-clean line"]
      if (m[1] !== m[2]) return [`only ${m[1]}/${m[2]} points clean`]
      if (Number(m[2]) !== 15) return [`expected 15 points, the sweep ran ${m[2]}`]
      return /RESULT: CLEAN/.test(out) ? [] : ["the sweep did not report RESULT: CLEAN"]
    },
  })
}

function gate7(): void {
  runGate("7", "sequential crash matrix", [BUN, "test", "test/isorun-crash.test.ts"], PKG, {
    readTotals: true,
    extraCheck: (_out, t) => (t && t.ran === 16 ? [] : [`expected 16 sequential points+fencing, ran ${t?.ran ?? "?"}`]),
  })
}

function gate8(): void {
  runGate("8", "full authoritative suite", [BUN, "scripts/measured-suite.ts", label], PKG, {
    extraCheck: (out) => {
      const problems: string[] = []
      if (!/RESULT: CLEAN/.test(out)) problems.push("the measured suite did not report RESULT: CLEAN")
      // PROOF A MUST HAVE RUN. A skipped live-medium proof is not a pass, and
      // this is the only place the round can tell the difference — the suite's
      // own exit code cannot.
      if (!/\[gate\] A live medium: trusted=true elevated=false integrity=medium rid=8192/.test(out)) {
        problems.push("proof A (live medium production path) did not RUN — a skipped A is not a pass")
      }
      if (!/\[gate\] B policy: elevated=true integrity=high -> elevated_host_not_supported/.test(out)) {
        problems.push("proof B (deterministic elevated-policy refusal) did not run")
      }
      // ── SKIPS ARE COMPARED BY IDENTITY, NOT BY COUNT (RC3 section 5) ──────
      //
      // This rule used to be "any skip fails the round". That is stricter than
      // it looks and weaker than it sounds: it forced every legitimately
      // elevated-only test to be deleted or disguised, while a test that started
      // skipping for a NEW reason would have been indistinguishable from one
      // that was always allowed to. `test/gate8-expected-skips.ts` names the
      // permitted skips exactly, each with the separate gate that supplies the
      // proof it omits, and the suite reports the identities it actually
      // skipped so the two sets can be compared.
      if (/SKIP ALLOWLIST VIOLATIONS/.test(out)) {
        problems.push("the suite's skipped tests do not match the expected-skip allowlist (see SKIP ALLOWLIST VIOLATIONS in the log)")
      }
      if (!/skipped identities \(\d+\):/.test(out)) {
        problems.push("the suite did not report WHICH tests it skipped; a skip count alone cannot be checked against the allowlist")
      }
      for (const s of EXPECTED_SKIPS) {
        if (!out.includes(s.identity)) problems.push(`the expected skip "${s.identity}" was not reported by the suite at all; the allowlist may be stale`)
      }
      const todo = /(\d+) todo/.exec(out)
      if (todo && Number(todo[1]) > 0) problems.push(`the suite reports ${todo[1]} todo test(s); an authoritative round requires todo = 0`)
      return problems
    },
  })
}

const ORDER: { n: string; fn: () => void }[] = [
  { n: "1", fn: gate1 },
  { n: "2", fn: gate2 },
  { n: "3", fn: gate3 },
  { n: "4", fn: gate4 },
  { n: "5", fn: gate5 },
  { n: "6", fn: gate6 },
  { n: "7", fn: gate7 },
  { n: "8", fn: gate8 },
]

log("")
log("═══ GATES ═══")
for (const g of ORDER) {
  g.fn()
  if (firstFailure) {
    log("")
    log(`STOPPING: ${firstFailure} failed. No later gate is run, and none may be reported.`)
    break
  }
}

// ── GATE 9: the final census. Runs even after a failure, because what the ──
//    round left on the machine is a fact worth recording either way.
log("")
log("── GATE 9: zero-residue census")
const after = takeCensus()
const residueAfter = ownedResidue(after.census)
log(`   census AFTER: ${formatCensus(after.census)}`)
log(`   OWNED RESIDUE TOTAL = ${residueAfter}`)
const gate9Pass = residueAfter === 0
writeFileSync(
  join(ARTIFACTS, "gate9-final-residue-census.log"),
  [
    "=== GATE 9 - FINAL ZERO-RESIDUE CENSUS ===",
    `takenAtUtc = ${new Date().toISOString()}`,
    `helper processes (abdo-winiso.exe) : ${after.census.helpers}`,
    `  of which keepers (--job-keeper)  : ${after.census.keepers}`,
    `hostile targets (abdo-hostile-target.exe) : ${after.census.hostiles}`,
    `AppContainer profiles (LOCALAPPDATA\\Packages\\abdo-winiso-*) : ${after.census.profiles}`,
    `harness queue dirs (TEMP\\abdo-winiso-harness-*) : ${after.census.queues}`,
    `Abdo execution root (C:\\ProgramData\\Abdo) exists : ${after.census.rootExists}`,
    `stray PING.EXE : ${after.census.strayPing}`,
    "",
    `OWNED RESIDUE TOTAL = ${residueAfter}`,
    `RESULT: ${gate9Pass ? "ZERO OWNED RESIDUE" : "RESIDUE PRESENT"}`,
    "",
    `raw: ${after.raw}`,
  ].join("\n"),
  "utf8",
)
gates.push({
  n: "9",
  name: "zero-residue census",
  cmd: ["<in-process census>"],
  cwd: PKG,
  exitCode: gate9Pass ? 0 : 1,
  durationSec: 0,
  logFile: join(ARTIFACTS, "gate9-final-residue-census.log"),
  status: gate9Pass ? "pass" : "fail",
  notes: gate9Pass ? [] : [`owned residue = ${residueAfter}`],
})
log(`   -> ${gate9Pass ? "PASS" : "FAIL"}`)
if (!gate9Pass && !firstFailure) firstFailure = "gate 9 (zero-residue census)"

// ── the binary must not have moved under the round ────────────────────────
const diskHashAfter = existsSync(HELPER) ? await sha256File(HELPER) : ""
const fixtureHashAfter = existsSync(FIXTURE) ? await sha256File(FIXTURE) : ""
const selfAfter = helperSelfReport()
// BOTH artefacts must be unchanged. A round in which the adversary binary moved
// measured hostility against two different programs.
const fixtureStable = fixtureHashAfter === fixtureHashBefore
const hashStable = diskHashAfter === diskHashBefore && selfAfter.binaryHash === diskHashBefore && fixtureStable
log("")
log(`helper  hash AFTER gate 9: ${diskHashAfter}`)
log(`fixture hash AFTER gate 9: ${fixtureHashAfter}`)
log(`fixture hash STABLE across the round: ${fixtureStable}`)
log(`binary hashes STABLE across the round (helper + fixture): ${hashStable}`)
const integrityStable = selfAfter.elevated === false && selfAfter.integrity === "medium" && selfAfter.integrityRid === 8192
log(`medium integrity held to the end: ${integrityStable} (elevated=${String(selfAfter.elevated)} integrity=${String(selfAfter.integrity)} rid=${String(selfAfter.integrityRid)})`)

// ── no code change during the round ───────────────────────────────────────
const gitHeadAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
const gitStatusAfter = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
const headUnchanged = gitHeadAfter === gitHead
log(`git HEAD unchanged: ${headUnchanged} (${gitHeadAfter})`)

// ══ REPORT ════════════════════════════════════════════════════════════════

const ranGates = gates.filter((g) => g.status === "pass").length
const allNine = ["1", "2a", "2b", "3", "4", "5", "6", "7", "8", "9"].every((n) => gates.some((g) => g.n === n && g.status === "pass"))
const ok = preflightOk && !firstFailure && allNine && hashStable && integrityStable && gate9Pass && headUnchanged

log("")
log("═══ ROUND SUMMARY ═══")
for (const g of gates) {
  const t = g.totals ? ` · ${g.totals.pass}p/${g.totals.fail}f/${g.totals.skip}s/${g.totals.todo}t/${g.totals.ran}ran` : ""
  log(`  gate ${g.n.padEnd(3)} ${g.status.toUpperCase().padEnd(4)} ${g.durationSec}s${t}  ${g.name}`)
}
log(`  gates passed: ${ranGates}/${gates.length}`)
log(`  elapsed: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`)
log(`  RESULT: ${ok ? "ALL NINE GATES GREEN" : "ROUND NOT GREEN"}`)
if (firstFailure) log(`  first failure: ${firstFailure}`)

const report = {
  label,
  outcome: ok ? "all_gates_green" : "not_green",
  gate1Started: true,
  toolchain: TOOLCHAIN,
  takenAtUtc: new Date().toISOString(),
  elapsedMin: Number(((Date.now() - started) / 1000 / 60).toFixed(1)),
  identity: {
    binaryHashBefore: diskHashBefore,
    binaryHashAfter: diskHashAfter,
    binaryHashStable: hashStable,
    liveBinaryHashAfter: String(selfAfter.binaryHash ?? ""),
    protocolVersion: self.protocolVersion,
    manifestSourceHash: String(manifest.helperSourceHash ?? ""),
    manifestBinaryHash: String(manifest.helperBinaryHash ?? ""),
    manifestBytes: manifest.helperBinaryBytes,
  },
  /** Artefact B — the adversary the containment tests actually run. */
  hostileTarget: {
    path: String(manifest.hostileTargetBinaryPath ?? ""),
    binaryHashBefore: fixtureHashBefore,
    binaryHashAfter: fixtureHashAfter,
    binaryHashStable: fixtureStable,
    manifestBinaryHash: String(manifest.hostileTargetBinaryHash ?? ""),
    manifestBytes: manifest.hostileTargetBytes,
    manifestSourceHash: String(manifest.hostileTargetSourceHash ?? ""),
    manifestSourceInputs: manifest.hostileTargetSourceInputs ?? null,
    toolchain: String(manifest.hostileTargetToolchain ?? ""),
    distinctFromHelper: fixtureHashBefore !== diskHashBefore,
  },
  environment: {
    elevatedAtStart: self.elevated,
    integrityAtStart: self.integrity,
    integrityRidAtStart: self.integrityRid,
    elevatedAtEnd: selfAfter.elevated,
    integrityAtEnd: selfAfter.integrity,
    integrityRidAtEnd: selfAfter.integrityRid,
    mediumIntegrityHeld: integrityStable,
    osBuildNumber: self.osBuildNumber,
  },
  provenance: {
    gitHeadBefore: gitHead,
    gitHeadAfter: gitHeadAfter,
    gitHeadUnchanged: headUnchanged,
    dirtyEntriesBefore: gitStatus === "" ? 0 : gitStatus.split("\n").length,
    dirtyEntriesAfter: gitStatusAfter === "" ? 0 : gitStatusAfter.split("\n").length,
  },
  residue: { before: before.census, after: after.census, ownedResidueBefore: ownedResidue(before.census), ownedResidueAfter: residueAfter },
  preflight: pf,
  gates: gates.map((g) => ({
    gate: g.n,
    name: g.name,
    status: g.status,
    exitCode: g.exitCode,
    durationSec: g.durationSec,
    cmd: g.cmd.join(" "),
    logFile: g.logFile,
    ...(g.totals ? { totals: g.totals } : {}),
    ...(g.parseError ? { parseError: g.parseError } : {}),
    ...(g.notes.length ? { notes: g.notes } : {}),
  })),
  firstFailure: firstFailure ?? null,
}
writeFileSync(join(ARTIFACTS, "ROUND.json"), JSON.stringify(report, null, 2), "utf8")
writeFileSync(join(ARTIFACTS, "ROUND.log"), `${lines.join("\n")}\n`, "utf8")
log(`  artifacts: ${ARTIFACTS}`)
process.exit(ok ? 0 : 1)
