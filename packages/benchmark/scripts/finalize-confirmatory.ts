#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import {
  CONFIRMATORY_DESIGN,
  CONFIRMATORY_FINGERPRINT,
  METRICS_SCHEMA_VERSION,
  mergeRecoveryGateEvidence,
  type GateResult,
  type RecoveryGateEvidence,
} from "../src/index"

interface PersistedTrial {
  readonly taskId: string
  readonly runtime: "v1" | "v2"
  readonly objectiveCorrect: boolean
}

interface CrashResult {
  readonly resumeSucceeded: boolean
  readonly duplicateSideEffects: number
}

interface PersistedReport {
  readonly label: string
  readonly provider: string
  readonly model: string
  readonly metricsSchemaVersion: number
  readonly suiteFingerprint: string
  readonly preregistration: { readonly pairs: number }
  readonly trials: readonly PersistedTrial[]
  readonly paired: Record<string, number | boolean | string>
  readonly recovery: {
    readonly v2_recovery: string
    readonly v2_duplicate_side_effects: number
    readonly detail: readonly CrashResult[]
  }
  readonly gate: GateResult
}

const invariant: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`confirmatory finalization refused: ${message}`)
}

const close = (actual: unknown, expected: number, name: string): void => {
  invariant(typeof actual === "number" && Number.isFinite(actual), `${name} is not a finite number`)
  invariant(Math.abs(actual - expected) < 1e-12, `${name} mismatch: recorded ${actual}, recomputed ${expected}`)
}

const [inputArg, outputArg] = process.argv.slice(2)
invariant(inputArg && outputArg, "usage: finalize-confirmatory.ts <raw-report.json> <official-verdict.json>")

const input = resolve(inputArg)
const output = resolve(outputArg)
const repoRoot = resolve(import.meta.dir, "../../..")
const raw = readFileSync(input)
const report = JSON.parse(raw.toString("utf8")) as PersistedReport

invariant(report.label === "confirmatory", `expected label confirmatory, got ${report.label}`)
invariant(report.metricsSchemaVersion === METRICS_SCHEMA_VERSION, `metrics schema ${report.metricsSchemaVersion} is not current ${METRICS_SCHEMA_VERSION}`)
invariant(report.suiteFingerprint === CONFIRMATORY_FINGERPRINT, "suite fingerprint does not match the frozen suite")
invariant(report.preregistration.pairs === CONFIRMATORY_DESIGN.pairs, "persisted preregistration pair count drifted")
invariant(report.trials.length === CONFIRMATORY_DESIGN.pairs * 2, `expected ${CONFIRMATORY_DESIGN.pairs * 2} trials, got ${report.trials.length}`)

const pairs = new Map<string, { v1?: boolean; v2?: boolean }>()
for (const trial of report.trials) {
  const pair = pairs.get(trial.taskId) ?? {}
  invariant(pair[trial.runtime] === undefined, `duplicate ${trial.runtime} side for ${trial.taskId}`)
  pair[trial.runtime] = trial.objectiveCorrect
  pairs.set(trial.taskId, pair)
}
invariant(pairs.size === CONFIRMATORY_DESIGN.pairs, `expected ${CONFIRMATORY_DESIGN.pairs} pairs, got ${pairs.size}`)

let v1Successes = 0
let v2Successes = 0
let bothSuccess = 0
let bothFail = 0
let v1Only = 0
let v2Only = 0
let sumD = 0
let sumD2 = 0
for (const [taskId, pair] of pairs) {
  invariant(pair.v1 !== undefined && pair.v2 !== undefined, `missing pair side for ${taskId}`)
  const v1 = pair.v1
  const v2 = pair.v2
  if (v1) v1Successes++
  if (v2) v2Successes++
  if (v1 && v2) bothSuccess++
  else if (!v1 && !v2) bothFail++
  else if (v1) v1Only++
  else v2Only++
  const difference = Number(v2) - Number(v1)
  sumD += difference
  sumD2 += difference * difference
}

const n = pairs.size
const observedDifference = sumD / n
const standardError = Math.sqrt(Math.max(0, sumD2 - (sumD * sumD) / n) / (n * (n - 1)))
const ciLower = observedDifference - CONFIRMATORY_DESIGN.zCritical * standardError
const ciUpper = observedDifference + CONFIRMATORY_DESIGN.zCritical * standardError
const paired = {
  pairs: n,
  v1Successes,
  v2Successes,
  v1SuccessRate: v1Successes / n,
  v2SuccessRate: v2Successes / n,
  observedDifference,
  concordantBothSuccess: bothSuccess,
  concordantBothFail: bothFail,
  discordantV1Only: v1Only,
  discordantV2Only: v2Only,
  standardError,
  ciLower,
  ciUpper,
  margin: CONFIRMATORY_DESIGN.nonInferiorityMargin,
  nonInferior: ciLower > CONFIRMATORY_DESIGN.nonInferiorityMargin,
}

for (const [name, expected] of Object.entries(paired)) {
  if (typeof expected === "number") close(report.paired[name], expected, `paired.${name}`)
  else invariant(report.paired[name] === expected, `paired.${name} mismatch`)
}

const duplicateSideEffects = report.recovery.detail.reduce((total, result) => total + result.duplicateSideEffects, 0)
const succeeded = report.recovery.detail.filter((result) => result.resumeSucceeded && result.duplicateSideEffects === 0).length
const recoveryEvidence: RecoveryGateEvidence = {
  source: "local-crash-injection",
  attempted: report.recovery.detail.length,
  succeeded,
  duplicateSideEffects,
}
invariant(report.recovery.v2_recovery === `${succeeded}/${recoveryEvidence.attempted}`, "display recovery count disagrees with crash detail")
invariant(report.recovery.v2_duplicate_side_effects === duplicateSideEffects, "display duplicate count disagrees with crash detail")

const aggregateGate = mergeRecoveryGateEvidence(report.gate, recoveryEvidence)
invariant(paired.nonInferior, `primary non-inferiority failed: lower CI ${ciLower}`)
invariant(aggregateGate.passed, "aggregate comparative + recovery gate did not pass")

const verdict = {
  schemaVersion: 1,
  kind: "abdo-confirmatory-official-verdict",
  generatedAt: new Date().toISOString(),
  source: {
    path: relative(repoRoot, input).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(raw).digest("hex"),
    label: report.label,
    provider: report.provider,
    model: report.model,
    metricsSchemaVersion: report.metricsSchemaVersion,
    suiteFingerprint: report.suiteFingerprint,
  },
  runIntegrity: {
    trials: report.trials.length,
    pairs: pairs.size,
    badPairs: 0,
    preregistrationMatched: true,
  },
  paired,
  recoveryEvidence,
  aggregateGate,
  decision: {
    primaryNonInferiority: "pass",
    aggregateGate: "pass",
    confirmatoryOutcome: "PASS",
    megaSprint1Outcome: "NOT_CLAIMED_P14_PENDING",
  },
}

mkdirSync(dirname(output), { recursive: true })
const temporary = `${output}.tmp-${process.pid}`
writeFileSync(temporary, `${JSON.stringify(verdict, null, 2)}\n`)
renameSync(temporary, output)
console.log(JSON.stringify({ output, sourceSha256: verdict.source.sha256, decision: verdict.decision, aggregateGatePassed: aggregateGate.passed }))
