/**
 * CL-16A3 MEGA-1 §5b — a DETERMINISTIC capture of the failing case.
 *
 * Not a test. It reproduces the one scenario that poisons the shared execution
 * root — a host killed at `after_grants_applied_before_event` — and prints every
 * fact needed to tell five explanations apart:
 *
 *   A. restore returns a SEMANTICALLY EQUIVALENT but non-identical descriptor
 *   B. one or more AppContainer ACEs SURVIVE
 *   C. the same object was granted MULTIPLE TIMES with chained originalSddl
 *   D. recovery reported `reclaimed` despite a failed or skipped restore
 *   E. the root marker/hash check is comparing the WRONG BASELINE
 *
 * Run:  bun test/measure-p5b.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { removeOwnedDirectoryTree } from "../src/controlled-fs"
import { bootstrapExecutionRoot } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { recoverIsolatedRuns, scanIsolatedRuns } from "../src/isorun-recovery"
import { RunGrantEvents } from "../src/run-scope"
import { harnessHelperRunner, helperBinaryHash, queueDir, runDirect, runUnelevated, stopServer } from "./harness"

const POINT = "after_grants_applied_before_event"
const PROGRAMDATA = String((await runUnelevated(["known-folder", "--id", "ProgramData"])).lexicalPath ?? "")
const ABDO_ROOT = join(PROGRAMDATA, "Abdo")
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every ACE in an SDDL's DACL, in order, as written. */
const aceList = (sddl: string): string[] => (sddl.match(/\(([^)]*)\)/g) ?? []).map((a) => a)
/** The same ACEs, order-insensitive and case-folded — the "semantic" view. */
const aceSet = (sddl: string): string => [...aceList(sddl)].map((a) => a.toLowerCase()).sort().join("")

const acl = (p: string) => String(runDirect(["inspect-acl", "--path", p]).sddl ?? "")
const ident = (p: string) => {
  const d = runDirect(["inspect-dir", "--path", p])
  return { exists: d.pathExists === true, finalPath: String(d.pathFinalPath ?? ""), fileId: String(d.pathFileId ?? ""), vol: String(d.pathVolumeSerial ?? "") }
}

console.log(`\n=== P5b root-poisoning capture — killing at ${POINT} ===\n`)

// ---- 0. A GUARANTEED-PRISTINE STARTING POINT.
rmSync(ABDO_ROOT, { recursive: true, force: true })
const scratch = mkdtempSync(join(tmpdir(), "abdo-p5bmeasure-"))
const dbPath = join(scratch, "crash.sqlite")
const markerPath = join(scratch, "marker")

// ---- 1. Run a host and kill it exactly at the point.
const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "isorun-crash-child.ts"), dbPath, POINT, markerPath, "3000"], {
  env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
  stdout: "pipe",
  stderr: "pipe",
})
const deadline = Date.now() + 120_000
while (Date.now() < deadline && !existsSync(markerPath)) {
  if (existsSync(`${markerPath}.error`)) {
    console.log("CHILD FAILED:", await Bun.file(`${markerPath}.error`).text())
    process.exit(1)
  }
  await sleep(100)
}
Bun.spawnSync([String.raw`C:\Windows\System32\taskkill.exe`, "/PID", String(child.pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
await sleep(1500)
console.log(`host killed at ${POINT}\n`)

// ---- 2. WHAT THE JOURNAL RECORDED, per ACL mutation.
const store = new SqliteEventStore(dbPath)
const runs = await scanIsolatedRuns(store)
const run = runs[0]!
const events = await store.read("project", `winiso:isorun:${run.runId}`)

const mutations = events.filter((e) => e.type === RunGrantEvents.GrantsMutating).map((e) => e.data as Record<string, unknown>)
const observed = events.filter((e) => e.type === RunGrantEvents.GrantObserved).map((e) => e.data as Record<string, unknown>)

console.log(`--- ACL mutations recorded: ${mutations.length}, observations: ${observed.length} ---`)
const timesGranted = new Map<string, number>()
for (const [i, m] of mutations.entries()) {
  const path = String(m.path ?? "")
  const key = path.toLowerCase()
  timesGranted.set(key, (timesGranted.get(key) ?? 0) + 1)
  const id = ident(path)
  const obs = observed.find((o) => String(o.path ?? "").toLowerCase() === key)
  console.log(`\n[${i}] ${path}`)
  console.log(`     purpose        : ${String(m.purpose ?? "")}`)
  console.log(`     canonical      : ${id.finalPath}`)
  console.log(`     identity       : fileId=${id.fileId} vol=${id.vol} exists=${id.exists}`)
  console.log(`     grants of this : ${timesGranted.get(key)}   <-- (C) if > 1`)
  console.log(`     originalSddl   : ${String(m.originalSddl ?? "")}`)
  console.log(`     observedGranted: ${obs ? String(obs.grantedSddl ?? "") : "(NO grant_observed — killed before it landed)"}`)
  console.log(`     ACEs before    : ${JSON.stringify(aceList(String(m.originalSddl ?? "")))}`)
  console.log(`     ACEs after     : ${JSON.stringify(aceList(obs ? String(obs.grantedSddl ?? "") : ""))}`)
  console.log(`     SDDL NOW       : ${acl(path)}`)
}

console.log(`\n--- objects granted more than once (hypothesis C) ---`)
const dupes = [...timesGranted.entries()].filter(([, n]) => n > 1)
console.log(dupes.length === 0 ? "  none" : dupes.map(([p, n]) => `  ${p} x${n}`).join("\n"))

// ---- 3. THE ROOT, before recovery.
const rootPath = run.runPath ? run.runPath.slice(0, run.runPath.toLowerCase().indexOf("\\runs\\")) : ""
console.log(`\n--- execution root: ${rootPath} ---`)
const rootBefore = acl(rootPath)
console.log(`  SDDL before recovery : ${rootBefore}`)
console.log(`  identity             : ${JSON.stringify(ident(rootPath))}`)

// ---- 4. RECOVERY, and exactly what it was given and what it produced.
console.log(`\n--- recovery ---`)
const outcomes = await recoverIsolatedRuns({
  store,
  helper: async ({ argv }) => runDirect(argv),
  now: () => Date.now() + 600_000,
  removeDirectory: removeOwnedDirectoryTree,
})
for (const o of outcomes) {
  console.log(`  action   : ${o.action}       <-- (D) if "reclaimed" while anything below is dirty`)
  console.log(`  detail   : ${o.detail}`)
  console.log(`  restored : ${JSON.stringify(o.restored ?? [])}`)
  console.log(`  unproven : ${JSON.stringify(o.unproven ?? [])}`)
}

// ---- 5. PER OBJECT: does the descriptor now equal the original, exactly?
console.log(`\n--- after restore, per object ---`)
for (const m of mutations) {
  const path = String(m.path ?? "")
  const original = String(m.originalSddl ?? "")
  const now = acl(path)
  const gone = !ident(path).exists
  const exact = now === original
  const semantic = aceSet(now) === aceSet(original)
  const carriesAc = /;;;S-1-15-2-/i.test(now)
  console.log(`\n  ${path}`)
  console.log(`    object exists   : ${!gone}`)
  console.log(`    restore input   : original=${original.slice(0, 60)}...`)
  console.log(`    SDDL after      : ${now}`)
  console.log(`    EXACT match     : ${exact}                 <-- (A) if false but semantic true`)
  console.log(`    SEMANTIC match  : ${semantic}`)
  console.log(`    AppContainer ACE: ${carriesAc}              <-- (B) if true`)
}

// ---- 6. THE ROOT'S OWN PROOF. This is what the next bootstrap actually runs,
// and a per-path ACE assertion is NOT a substitute for it.
console.log(`\n--- root after recovery ---`)
const rootAfter = acl(rootPath)
console.log(`  SDDL after recovery  : ${rootAfter}`)
console.log(`  equals pre-recovery? : ${rootAfter === rootBefore}`)
console.log(`  DACL hash            : ${sha256(rootAfter)}`)

const markerFile = join(rootPath, "root.marker")
if (existsSync(markerFile)) {
  const marker = JSON.parse(await Bun.file(markerFile).text()) as Record<string, unknown>
  console.log(`  marker protectedDaclHash : ${String(marker.protectedDaclHash ?? "")}   <-- (E) baseline`)
  console.log(`  marker rootFinalPath     : ${String(marker.rootFinalPath ?? marker.executionRootFinalPath ?? "")}`)
} else {
  console.log(`  marker: MISSING at ${markerFile}`)
}

// ---- 7. CAN A NEW HOST ACTUALLY BOOTSTRAP? The real question.
console.log(`\n--- bootstrapExecutionRoot from a FRESH store (the failing step) ---`)
const freshStore = new SqliteEventStore(join(scratch, "fresh.sqlite"))
const boot = await bootstrapExecutionRoot({
  store: freshStore,
  helper: harnessHelperRunner(),
  helperProtocol: REQUIRED_PROTOCOL_VERSION,
  helperHash: helperBinaryHash(),
  // THE SAME inventory hash the child used. The root marker BINDS this value,
  // so a different string here is refused as an ownership conflict — which is
  // correct behaviour, and was masking the real question on the first run.
  profileInventory: { complete: true, hash: "crash-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] },
  rightsModelVersion: RIGHTS_MODEL_VERSION,
})
console.log(`  ok        : ${boot.ok}`)
if (!boot.ok) {
  console.log(`  reasonCode: ${boot.reasonCode}`)
  console.log(`  detail    : ${boot.detail}`)
}
freshStore.close()
store.close()

console.log(`\n--- residual AppContainer profiles on this machine ---`)
console.log(`  ${run.profileName ?? "(none recorded)"} exists: ${ident(join(process.env.LOCALAPPDATA ?? "", "Packages", run.profileName ?? "x")).exists}`)

rmSync(scratch, { recursive: true, force: true })
stopServer()
console.log(`\n=== capture complete ===\n`)
