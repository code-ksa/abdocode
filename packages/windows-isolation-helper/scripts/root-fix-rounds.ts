/**
 * CL-16A3-B2B-ROOT-FINAL-GATE §6 — the formal rounds, now self-cleaning.
 *
 * Runs the crash matrix and the concurrency proof twenty times each, then tears
 * the round's own resources down DETERMINISTICALLY before the AFTER census — it
 * does not leave a leaked server, its console or its queues for the next
 * invocation to reap. The round is judged on OWNED residue: helpers and queues
 * are the round's by exact identity, consoles by "new since the round began".
 *
 * Round 2 must run against the SAME helper as Round 1, so this refuses to start
 * if the binary hash does not match the manifest.
 *
 *   bun scripts/root-fix-rounds.ts --round 1 [--iterations 20]
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { type Census, DEFAULT_REAP, deterministicReap, ownedResidue, snapshot } from "./harness-teardown"

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? d) : d
}
const round = arg("round", "1")
const iterations = Number(arg("iterations", "20"))
const PKG = join(import.meta.dir, "..")
const HELPER = join(PKG, "target", "release", "abdo-winiso.exe")
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
const runHelper = (argv: string[]) => {
  const p = Bun.spawnSync([HELPER, ...argv], { stdout: "pipe", stderr: "pipe" })
  try {
    return JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}
const ps = (c: string) => Bun.spawnSync([PS, "-NoProfile", "-Command", c], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()

/** AppContainer profiles this project owns, by its ownership prefix. */
const abdoProfiles = (): string[] => {
  const out = ps("Get-ChildItem \"$env:LOCALAPPDATA\\Packages\" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'abdo-winiso-*' } | ForEach-Object { $_.Name }")
  return out ? out.split(/\r?\n/).filter(Boolean) : []
}

// Round 2 cannot silently measure a rebuilt helper.
const manifest = JSON.parse(readFileSync(join(PKG, "helper-manifest.json"), "utf8")) as Record<string, unknown>
const binaryHash = sha256File(HELPER)
if (binaryHash !== manifest.helperBinaryHash) {
  console.error(`REFUSED: the helper binary (${binaryHash.slice(0, 12)}) is not the one the manifest describes (${String(manifest.helperBinaryHash).slice(0, 12)}).`)
  console.error("A round measured against a rebuilt helper is a different experiment. Rebuild the manifest or restore the binary.")
  process.exit(2)
}

const kf = runHelper(["known-folder", "--id", "ProgramData"])
const programData = String(kf.lexicalPath ?? "")
const executionParent = join(programData, "Abdo", "Execution")
const stagingParent = join(executionParent, ".staging")
const abdoRoot = join(programData, "Abdo")
const pdDaclBefore = String(runHelper(["inspect-acl", "--path", programData]).sddl ?? "")

// The BEFORE baseline: owned attribution is measured against this exact moment.
const baseline: Census = snapshot()
const ownedBefore = ownedResidue(baseline, baseline)
const profilesBefore = abdoProfiles()
const stagingBefore = existsSync(stagingParent) ? readdirSync(stagingParent) : []
const rootBefore = existsSync(abdoRoot)

console.log(`=== ROUND ${round} — CL-16A3-B2B-ROOT-FINAL-GATE ===`)
console.log(`helper binary hash : ${binaryHash}`)
console.log(`helper protocol    : ${String(manifest.helperProtocolVersion)}`)
console.log(`ProgramData        : ${programData}`)
console.log(`ProgramData DACL   : ${pdDaclBefore}`)
console.log(`census before      : helpers=${baseline.helperPids.length} WT=${baseline.windowsTerminalPids.length} conhost=${baseline.conhostPids.length} queues=${baseline.queues.length}`)
console.log(`profiles before    : ${profilesBefore.length}${profilesBefore.length ? ` (${profilesBefore.join(", ")})` : ""}`)
console.log(`root before        : ${rootBefore ? "present" : "none"}   staging before: ${stagingBefore.length}`)
console.log("")

const SUITES: { name: string; file: string }[] = [
  { name: "crash matrix", file: "test/execution-root-crash.test.ts" },
  { name: "concurrency", file: "test/execution-root-concurrency.test.ts" },
]

type Tally = { pass: number; fail: number; skip: number; todo: number; ran: number }
const totals: Record<string, Tally> = {}
let anyFailure = false

for (const suite of SUITES) {
  const t: Tally = { pass: 0, fail: 0, skip: 0, todo: 0, ran: 0 }
  for (let i = 1; i <= iterations; i++) {
    const p = Bun.spawnSync([process.execPath, "test", suite.file], { cwd: PKG, stdout: "pipe", stderr: "pipe" })
    const out = `${p.stdout.toString()}\n${p.stderr.toString()}`
    const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? "0")
    const pass = num(/(\d+) pass/)
    const fail = num(/(\d+) fail/)
    const skip = num(/(\d+) skip/)
    const todo = num(/(\d+) todo/)
    const ran = num(/Ran (\d+) tests/)
    t.pass += pass
    t.fail += fail
    t.skip += skip
    t.todo += todo
    t.ran += ran
    if (fail > 0 || ran === 0) {
      anyFailure = true
      console.log(`  ${suite.name} #${i}: FAIL pass=${pass} fail=${fail} ran=${ran}`)
      writeFileSync(join(PKG, `round-${round}-${suite.name.replace(/\W/g, "-")}-${i}.log`), out, "utf8")
    } else {
      process.stdout.write(`  ${suite.name} #${i}: ${pass}/${ran} ok\n`)
    }
  }
  totals[suite.name] = t
}

// ──────────────────────────── deterministic teardown ────────────────────────
// The round cleans up after ITSELF here, before the AFTER census — no reliance
// on a later `bun test` invocation to reap what this round created.
console.log("\n--- deterministic teardown ---")
const reap = await deterministicReap(baseline, DEFAULT_REAP)
console.log(`reaped ${reap.queuesReaped}/${reap.consideredQueues} owned queues · ${reap.serversStopped} servers stopped · ${reap.retriesUsed} rm retries · ${reap.teardownMs}ms`)
if (reap.failures.length) console.log(`cleanup FAILURES : ${JSON.stringify(reap.failures)}`)
if (reap.deferred.length) console.log(`cleanup DEFERRED : ${JSON.stringify(reap.deferred)}`)

// The execution root is product output, not harness residue; the tests are meant
// to leave it removed, so a leftover root is itself a finding — recorded, then removed.
const stagingAfter = existsSync(stagingParent) ? readdirSync(stagingParent) : []
const rootAfter = existsSync(abdoRoot)
try {
  rmSync(abdoRoot, { recursive: true, force: true })
} catch {
  /* best effort */
}

// ──────────────────────────── AFTER census (owned) ──────────────────────────
const after = snapshot()
const owned = ownedResidue(baseline, after)
const profilesAfter = abdoProfiles()
const ownedProfiles = profilesAfter.filter((p) => !profilesBefore.includes(p))
const pdDaclAfter = String(runHelper(["inspect-acl", "--path", programData]).sddl ?? "")

const cleanupClean = reap.failures.length === 0 && reap.deferred.length === 0
const residueClean =
  owned.clean &&
  cleanupClean &&
  ownedProfiles.length === 0 &&
  stagingAfter.length === 0 &&
  pdDaclAfter === pdDaclBefore
const verdict = !anyFailure && residueClean

console.log("\n--- ROUND REPORT ---")
for (const [name, t] of Object.entries(totals)) console.log(`${name.padEnd(14)}: pass=${t.pass} fail=${t.fail} skip=${t.skip} todo=${t.todo} ran=${t.ran} over ${iterations} iterations`)
console.log(`helper hash        : ${binaryHash.slice(0, 24)}…   protocol: ${String(manifest.helperProtocolVersion)}`)
console.log(`owned before       : helper=${ownedBefore.ownedHelper} queue=${ownedBefore.ownedQueue} WT=${ownedBefore.ownedWindowsTerminal} conhost=${ownedBefore.ownedConhost}`)
console.log(`owned after        : helper=${owned.ownedHelper} queue=${owned.ownedQueue} WT=${owned.ownedWindowsTerminal} conhost=${owned.ownedConhost}`)
console.log(`queues before/after: ${baseline.queues.length} / ${after.queues.length}   (owned queues remaining: ${owned.ownedQueue})`)
console.log(`system conhost     : ${baseline.conhostPids.length} -> ${after.conhostPids.length} (delta ${owned.conhostDelta}, not attributed to the round unless owned)`)
console.log(`system WT          : ${baseline.windowsTerminalPids.length} -> ${after.windowsTerminalPids.length} (delta ${owned.windowsTerminalDelta})`)
console.log(`root residue       : ${rootAfter ? "PRESENT (removed now)" : "none"}`)
console.log(`staging residue    : ${stagingAfter.length === 0 ? "none" : stagingAfter.join(", ")}`)
console.log(`profile residue    : ${ownedProfiles.length === 0 ? "none" : ownedProfiles.join(", ")}`)
console.log(`marker-temp        : ${stagingAfter.length === 0 ? "none" : `${stagingAfter.length} in .staging`}`)
console.log(`ProgramData ACL    : ${pdDaclAfter === pdDaclBefore ? "UNCHANGED" : `CHANGED\n  before: ${pdDaclBefore}\n  after:  ${pdDaclAfter}`}`)
console.log(`teardown           : ${reap.teardownMs}ms · ${reap.serversStopped} servers stopped · ${reap.retriesUsed} rm retries · ${reap.queuesReaped}/${reap.consideredQueues} queues reaped`)
console.log(`cleanup failures   : ${reap.failures.length === 0 ? "none" : JSON.stringify(reap.failures)}`)
console.log(`cleanup deferred   : ${reap.deferred.length === 0 ? "none" : JSON.stringify(reap.deferred)}`)
console.log(`VERDICT            : ${verdict ? "PASS — zero owned residue, self-cleaning at this round's own boundary" : "FAIL"}`)
process.exit(verdict ? 0 : 1)
