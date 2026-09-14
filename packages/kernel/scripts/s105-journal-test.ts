import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const CRASH_PARENT_GATE = "ABDO_JOURNAL_CRASH_10K_PARENT_GATE"
const MIGRATION_PARENT_GATE = "ABDO_JOURNAL_MIGRATION_PARENT_GATE"
const RESTORE_PARENT_GATE = "ABDO_JOURNAL_RESTORE_100K_PARENT_GATE"
const JOURNAL_PARENT_GATES = [CRASH_PARENT_GATE, MIGRATION_PARENT_GATE, RESTORE_PARENT_GATE] as const

export type S105JournalGateName = "migration" | "restore" | "crash10k"

const MIGRATION_GATE_TIMEOUT_MS = 5 * 60_000
const RESTORE_GATE_TIMEOUT_MS = 5 * 60_000
const CRASH_GATE_TIMEOUT_MS = 31 * 60_000

const JOURNAL_GATES: readonly CargoGate[] = [
  {
    name: "migration",
    parentEnvironment: MIGRATION_PARENT_GATE,
    packageName: "abdo-journal",
    testTarget: "migration_atomicity",
    testName: "migration_interruption_is_atomic",
    features: "test-hooks",
    timeoutMs: MIGRATION_GATE_TIMEOUT_MS,
  },
  {
    name: "restore",
    parentEnvironment: RESTORE_PARENT_GATE,
    packageName: "abdo-journal",
    testTarget: "restore_100k",
    testName: "restores_hundred_thousand_events_within_two_seconds",
    features: "test-hooks",
    timeoutMs: RESTORE_GATE_TIMEOUT_MS,
  },
  {
    name: "crash10k",
    parentEnvironment: CRASH_PARENT_GATE,
    packageName: "abdo-journal",
    testTarget: "recovery_10k",
    testName: "crash_injection_ten_thousand_process_deaths",
    features: "test-hooks",
    timeoutMs: CRASH_GATE_TIMEOUT_MS,
  },
]

const JOURNAL_FAMILY: GateFamily = {
  label: "S105",
  parentEnvironments: JOURNAL_PARENT_GATES,
  gates: JOURNAL_GATES,
  validate: (name, output) => validateS105JournalGateOutput(name as S105JournalGateName, output),
}

export function runS105JournalGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(JOURNAL_FAMILY, preparedContext)
}

export async function runS105JournalGate(
  name: S105JournalGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(JOURNAL_FAMILY, name, preparedContext)
}

function journalGateByName(name: S105JournalGateName) {
  const gate = JOURNAL_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S105 journal gate")
  return gate
}

export function validateS105JournalGateOutput(name: S105JournalGateName, output: string) {
  const gate = journalGateByName(name)
  const evidence = acceptanceEvidence("S105", gate.testName, output)
  if (name === "migration") validateMigrationEvidence(evidence, gate.timeoutMs)
  else if (name === "restore") validateRestoreEvidence(evidence)
  else validateCrashEvidence(evidence)
}

function validateMigrationEvidence(line: string, timeoutMs: number) {
  if (!/^S105_MIGRATION_ATOMICITY points=[1-9]\d* elapsed_ms=\d+$/.test(line)) {
    throw new Error("S105 Cargo output must contain exact migration acceptance evidence")
  }
  const match = /^S105_MIGRATION_ATOMICITY points=([1-9]\d*) elapsed_ms=(\d+)$/.exec(line)!
  if (Number(match[1]) < 7 || Number(match[2]) > timeoutMs) {
    throw new Error("S105 migration acceptance evidence is outside its dynamic inventory or timeout bounds")
  }
}

function validateRestoreEvidence(line: string) {
  const pattern =
    /^S105_RESTORE_100K events=(\d+) snapshot=(\d+) tail=(\d+) fixture_ms=(\d+) open_ms=(\d+) restore_ms=(\d+) fold_ms=(\d+) total_ms=(\d+)$/
  if (!pattern.test(line)) throw new Error("S105 Cargo output must contain exact restore acceptance evidence")
  const values = pattern.exec(line)!.slice(1).map(Number)
  if (values[0] !== 100_000 || values[1] !== 90_000 || values[2] !== 10_000 || values[7]! > 2_000) {
    throw new Error("S105 restore acceptance evidence does not prove the exact 100k/90k/10k/2s contract")
  }
}

function validateCrashEvidence(line: string) {
  const pattern =
    /^S105_RECOVERY_10K injections=(\d+) lanes=(\d+) phase_counts=\[([0-9, ]+)\] elapsed_ms=(\d+)$/
  if (!pattern.test(line)) throw new Error("S105 Cargo output must contain exact crash acceptance evidence")
  const match = pattern.exec(line)!
  const phaseCounts = match[3]!.split(",").map((value) => Number(value.trim()))
  if (
    Number(match[1]) !== 10_000 ||
    Number(match[2]) !== 16 ||
    phaseCounts.length !== 10 ||
    phaseCounts.some((count) => count !== 1_000) ||
    Number(match[4]) > 30 * 60_000
  ) {
    throw new Error("S105 crash acceptance evidence does not prove 10k injections across 16 lanes and 10 phases")
  }
}

if (import.meta.main) {
  const exitCode = await runS105JournalGates()
  if (exitCode !== 0) process.exit(exitCode)
}
