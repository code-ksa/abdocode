/**
 * CL-16A2-D §5/§6 — run the suite as a MEASUREMENT, not just as tests.
 *
 * Counts the machine before, runs the suite, TEARS DOWN any de-elevation server
 * the suite left behind, counts the machine after, and fails the run on any
 * unexplained growth. A green suite that leaves a Windows Terminal window or an
 * orphaned console host behind is not a passing run, and until this existed
 * nothing in the repo could tell the difference.
 *
 * The teardown here is authoritative and does not trust the child's exit hook:
 * `bun test` runs in a child process whose own `stopServer` hook can be raced or
 * skipped, so after it returns this parent signals every leftover harness queue
 * to shut down and then WAITS for the helper process count to reach zero before
 * it dares take the "after" census. A census taken while the server is still
 * dying measures the teardown, not the leak.
 *
 *   bun scripts/measured-suite.ts [round-label] [single-test-file]
 *
 * EVIDENCE DURABILITY (the qualification-A remedy): every run persists, write-
 * through and unconditionally, under artifacts/gate8-rounds/<runId>/ —
 * transcript.txt (streamed as it happens, so a killed process still leaves
 * partial evidence), junit.xml (no longer deleted), ROUND.json (rewritten at
 * each phase), residue-census.txt. Capture only; nothing measured changes.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatCensus, judgeCensus, takeCensus } from "../test/census"
import { compareSkips, formatSkipComparison } from "../test/gate8-expected-skips"
import { parseJUnitSkips } from "../test/junit-skips"
import { ReportParseUnknown, type SuiteTotals, formatTotals, parseSuiteTotals } from "../test/suite-report"

const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
const QUEUE_PREFIX = "abdo-winiso-harness-"

const label = process.argv[2] ?? "round"
const started = Date.now()

// ── evidence durability: everything below is capture, not measurement ─────
const ROOT = join(import.meta.dir, "..", "..", "..")
const HOSTILE = join(import.meta.dir, "..", "target", "release", "abdo-hostile-target.exe")
const runId = `${label}-${started}`
const EVIDENCE = join(ROOT, "artifacts", "gate8-rounds", runId)
mkdirSync(EVIDENCE, { recursive: true })
const transcriptFile = join(EVIDENCE, "transcript.txt")
const roundFile = join(EVIDENCE, "ROUND.json")
const censusFile = join(EVIDENCE, "residue-census.txt")

const log = (m: string) => {
  const line = `[${label}] ${m}`
  console.log(line)
  try {
    appendFileSync(transcriptFile, `${line}\n`, "utf8")
  } catch {
    /* evidence must never break the measurement */
  }
}

const round: Record<string, unknown> = {}
function persistRound(phase: string, patch: Record<string, unknown>): void {
  Object.assign(round, patch)
  round.phase = phase
  round.updatedUtc = new Date().toISOString()
  try {
    writeFileSync(roundFile, JSON.stringify(round, null, 2), "utf8")
  } catch {
    /* same */
  }
}

function sha256File(p: string): string {
  try {
    const h = new Bun.CryptoHasher("sha256")
    h.update(new Uint8Array(readFileSync(p)))
    return h.digest("hex")
  } catch {
    return "unreadable"
  }
}

function integrityLevel(): string {
  try {
    const p = Bun.spawnSync(["whoami", "/groups"], { stdout: "pipe", stderr: "pipe" })
    const line = p.stdout.toString().split("\n").find((l) => l.includes("S-1-16-"))
    return line?.trim().replace(/\s+/g, " ") ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** The helper's self-reported identity — proved to match the file on disk elsewhere. */
function helperIdentity(): { binaryHash?: string; protocolVersion?: number; elevated?: boolean } {
  try {
    const p = Bun.spawnSync([HELPER, "version"], { stdout: "pipe", stderr: "pipe" })
    return JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}")
  } catch {
    return {}
  }
}

/** Ask every leftover harness queue to shut down; the owning test process is dead by now. */
function signalShutdownToLeftoverServers(): number {
  let n = 0
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(QUEUE_PREFIX)) continue
      try {
        writeFileSync(join(tmpdir(), name, "shutdown.req"), "", "utf8")
        n++
      } catch {
        /* nothing to shut down */
      }
    }
  } catch {
    /* TEMP unreadable */
  }
  return n
}

function removeLeftoverQueues(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(QUEUE_PREFIX)) continue
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true })
      } catch {
        /* a dying server may still hold a handle; its lock is DELETE_ON_CLOSE */
      }
    }
  } catch {
    /* TEMP unreadable */
  }
}

// ── measure the world before ──────────────────────────────────────────────
const ident = helperIdentity()
const before = takeCensus()
log(`BEFORE  ${formatCensus(before)}`)
log(`helper  binaryHash=${ident.binaryHash} protocolVersion=${ident.protocolVersion} elevated=${ident.elevated}`)

try {
  appendFileSync(censusFile, `BEFORE ${formatCensus(before)}\n`, "utf8")
} catch {
  /* capture only */
}
persistRound("running", {
  runId,
  label,
  startedUtc: new Date(started).toISOString(),
  head: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
  integrity: integrityLevel(),
  helperIdentity: ident,
  helperFileHash: sha256File(HELPER),
  hostileFileHash: sha256File(HOSTILE),
  beforeCensus: before,
})

// ── run the suite ─────────────────────────────────────────────────────────
//
// The JUnit reporter runs ALONGSIDE the text one, because the text summary gives
// a skip COUNT and Gate 8 has to compare skip IDENTITIES (RC3 section 5). "2
// skip" reads the same whether the two are the allowlisted two or two others.
const PKG_DIR = new URL("..", import.meta.url).pathname.replace(/^\//, "")
const junitFile = join(EVIDENCE, "junit.xml")
const testArgs = ["bun", "test", "--reporter=junit", `--reporter-outfile=${junitFile}`]
if (process.argv[3]) testArgs.push(process.argv[3])
// Bun.spawn instead of spawnSync so the transcript streams to disk WHILE the
// suite runs — a killed or usage-limited process still leaves evidence. The
// child command, cwd and captured text are unchanged.
const child = Bun.spawn(testArgs, { cwd: PKG_DIR, stdout: "pipe", stderr: "pipe" })
let stdoutText = ""
let stderrText = ""
async function tee(stream: ReadableStream<Uint8Array>, sink: (s: string) => void): Promise<void> {
  const dec = new TextDecoder()
  for await (const chunk of stream) {
    const s = dec.decode(chunk, { stream: true })
    sink(s)
    try {
      appendFileSync(transcriptFile, s, "utf8")
    } catch {
      /* capture only */
    }
  }
}
await Promise.all([tee(child.stdout, (s) => (stdoutText += s)), tee(child.stderr, (s) => (stderrText += s))])
await child.exited
const out = stdoutText + stderrText

// Bun reports totals on stderr; read them rather than trusting the exit code
// alone, so "0 tests ran" can never read as success. The parse is deterministic
// and REFUSES rather than guessing: an unreadable summary fails the round with
// `report_parse_unknown` instead of printing a placeholder number (the previous
// report said `skip=-1`, which was a parser miss dressed up as a measurement).
let totals: SuiteTotals | undefined
let parseError: string | undefined
try {
  totals = parseSuiteTotals(out)
} catch (e) {
  parseError = e instanceof ReportParseUnknown ? e.message : `report_parse_unknown: ${String(e)}`
}
const failures = out.split("\n").filter((l) => l.startsWith("(fail)"))
const gateLines = out.split("\n").filter((l) => l.includes("[gate]"))

// ── WHICH tests skipped, by identity, against the allowlist ───────────────
//
// An unreadable JUnit file is a FAILED round, not a warning: if the skipped set
// cannot be established there is no way to tell an allowlisted skip from a new
// one, and reporting the count alone is the exact substitution this check
// exists to prevent.
let skipProblems: string[] = []
let skippedIdentities: string[] = []
let todoIdentities: string[] = []
try {
  const parsed = parseJUnitSkips(readFileSync(junitFile, "utf8"))
  skippedIdentities = parsed.skipped
  todoIdentities = parsed.todo
  skipProblems = formatSkipComparison(compareSkips(skippedIdentities))
  for (const t of todoIdentities) skipProblems.push(`TODO TEST: "${t}" — an authoritative round requires todo = 0.`)
  // The identity set and the counter must agree, or one of them is lying.
  if (totals && skippedIdentities.length + todoIdentities.length !== totals.skip + totals.todo) {
    skipProblems.push(`the JUnit skip identities (${skippedIdentities.length} skip + ${todoIdentities.length} todo) do not match the summary counters (${totals.skip} skip + ${totals.todo} todo)`)
  }
} catch (e) {
  skipProblems = [`the JUnit report could not be read, so the skipped tests cannot be identified: ${String(e)}`]
}
// The JUnit file is EVIDENCE now — it stays in the run's directory.
persistRound("suite-complete", {
  totals: totals ?? null,
  parseError: parseError ?? null,
  suiteDurationSeconds: (Date.now() - started) / 1000,
  failureLines: failures,
  skippedIdentities,
  todoIdentities,
  skipProblems,
})

// ── tear the suite's de-elevation servers down, then WAIT for zero ─────────
const signalled = signalShutdownToLeftoverServers()
log(`teardown: signalled ${signalled} leftover queue(s); waiting for helper -> 0`)
let helperCount = takeCensus().helperProcesses
for (let i = 0; i < 40 && helperCount > 0; i++) {
  await Bun.sleep(500)
  helperCount = takeCensus().helperProcesses
}
removeLeftoverQueues()
await Bun.sleep(500)

// ── measure the world after, AT REST ──────────────────────────────────────
//
// The suite deliberately hard-kills processes (the crash matrix and the lease
// workers). A console host whose parent has just been killed can still be
// winding down when the census runs, and it counts as "orphaned" for the moment
// between its parent dying and itself exiting. Judging then measures the
// teardown, not a leak — measured here: the run failed on
// `conhostOrphaned 0 -> 1`, and the orphan was gone by the time it was
// inspected.
//
// So the census is re-taken until it settles, with a BOUND. The assertion is
// unchanged and the tolerance is still zero: a real orphan is by definition one
// that nobody will ever clean up, so it never settles and still fails the round.
let after = takeCensus()
for (let i = 0; i < 30 && !judgeCensus(before, after).ok; i++) {
  await Bun.sleep(1_000)
  after = takeCensus()
}
log(`AFTER   ${formatCensus(after)}`)

const verdict = judgeCensus(before, after)

// ── report ────────────────────────────────────────────────────────────────
if (totals) log(`tests: ${formatTotals(totals)}, ${((Date.now() - started) / 1000).toFixed(1)}s`)
else log(`tests: UNREADABLE - ${parseError}`)
log(`skipped identities (${skippedIdentities.length}):${skippedIdentities.length === 0 ? " none" : `\n  ${skippedIdentities.join("\n  ")}`}`)
if (todoIdentities.length) log(`TODO identities (${todoIdentities.length}):\n  ${todoIdentities.join("\n  ")}`)
if (skipProblems.length) log(`SKIP ALLOWLIST VIOLATIONS:\n  ${skipProblems.join("\n  ")}`)
if (gateLines.length) log(`proofs:\n  ${gateLines.map((l) => l.trim()).join("\n  ")}`)
if (failures.length) {
  log(`FAILURES:\n${failures.join("\n")}`)
  log(`--- tail of suite output ---\n${out.split("\n").slice(-60).join("\n")}`)
}
if (!verdict.ok) log(`CENSUS VIOLATIONS:\n  ${verdict.violations.join("\n  ")}`)

const helperResidue = after.helperProcesses > 0
if (helperResidue) log(`RESIDUE: ${after.helperProcesses} helper process(es) still running after teardown`)

// An unreadable summary is a FAILED ROUND. Not a warning, not a default: if the
// numbers cannot be established, there is no measurement to report.
const ok =
  totals !== undefined &&
  totals.fail === 0 &&
  totals.todo === 0 &&
  totals.ran > 0 &&
  totals.pass > 0 &&
  verdict.ok &&
  !helperResidue &&
  skipProblems.length === 0
log(`RESULT: ${ok ? "CLEAN" : "NOT CLEAN"}`)
try {
  appendFileSync(censusFile, `AFTER  ${formatCensus(after)}\n${verdict.ok ? "CENSUS OK" : `CENSUS VIOLATIONS:\n${verdict.violations.join("\n")}`}\n`, "utf8")
} catch {
  /* capture only */
}
persistRound("complete", {
  afterCensus: after,
  censusOk: verdict.ok,
  censusViolations: verdict.violations,
  helperResidue,
  helperFileHashAfter: sha256File(HELPER),
  hostileFileHashAfter: sha256File(HOSTILE),
  totalDurationSeconds: (Date.now() - started) / 1000,
  endedUtc: new Date().toISOString(),
  result: ok ? "CLEAN" : "NOT CLEAN",
})
log(`evidence: ${EVIDENCE}`)
process.exit(ok ? 0 : 1)
