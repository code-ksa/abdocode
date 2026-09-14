import {
  KERNEL_PACKAGE_DIR,
  prepareCargoContext,
  preparedCargoChildEnvironment,
  synchronizeGeneratedContracts,
  trustedBunExecutable,
} from "./contracts"
import { verifyBoundaryGuards } from "./guard"
import { runRustClippy, runRustTestsBeforeS105 } from "./rust-test"
import { runS105JournalGates } from "./s105-journal-test"
import { runS106ReducerGates } from "./s106-reducer-test"
import { runS107SupervisorGates } from "./s107-supervisor-test"
import { runS108ReconcileGates } from "./s108-reconcile-test"
import { runS109SessionGates } from "./s109-session-test"
import { runS110ControlGates } from "./s110-control-test"
import { runS111ScheduleGates } from "./s111-schedule-test"
import { runS112BudgetGates } from "./s112-budget-test"
import { runS113AuthorityGates } from "./s113-authority-test"
import { runS114PolicyGates } from "./s114-policy-test"
import { runS115BrokerGates } from "./s115-broker-test"
import { runS116DisclosureGates } from "./s116-disclosure-test"
import { runS117WorkerGates, verifyToolInventory } from "./s117-inventory-test"
import { runS118SecretGates } from "./s118-secret-test"
import { runS119SurfaceGates } from "./s119-surface-test"
import { runS142BridgeGates, verifyBridgeClient } from "./s142-bridge-test"

export async function runKernelTest() {
  const cargoLease = prepareCargoContext()
  try {
    const contracts = await synchronizeGeneratedContracts("check", cargoLease.context)
    const boundary = await verifyBoundaryGuards(cargoLease.context)
    // The survey runs before anything is built, which is the sprint's own
    // instruction: a gate that surveyed afterwards would be reporting on a
    // thing it had already changed.
    const inventory = await verifyToolInventory()

    const primaryRust = runRustTestsBeforeS105(cargoLease.context)
    if (primaryRust !== 0) return primaryRust
    const journal = await runS105JournalGates(cargoLease.context)
    if (journal !== 0) return journal
    const reducer = await runS106ReducerGates(cargoLease.context)
    if (reducer !== 0) return reducer
    const supervisor = await runS107SupervisorGates(cargoLease.context)
    if (supervisor !== 0) return supervisor
    const reconcile = await runS108ReconcileGates(cargoLease.context)
    if (reconcile !== 0) return reconcile
    const session = await runS109SessionGates(cargoLease.context)
    if (session !== 0) return session
    const control = await runS110ControlGates(cargoLease.context)
    if (control !== 0) return control
    const schedule = await runS111ScheduleGates(cargoLease.context)
    if (schedule !== 0) return schedule
    const budget = await runS112BudgetGates(cargoLease.context)
    if (budget !== 0) return budget
    const authority = await runS113AuthorityGates(cargoLease.context)
    if (authority !== 0) return authority
    const policy = await runS114PolicyGates(cargoLease.context)
    if (policy !== 0) return policy
    const broker = await runS115BrokerGates(cargoLease.context)
    if (broker !== 0) return broker
    const disclosure = await runS116DisclosureGates(cargoLease.context)
    if (disclosure !== 0) return disclosure
    const worker = await runS117WorkerGates(cargoLease.context)
    if (worker !== 0) return worker
    const secrets = await runS118SecretGates(cargoLease.context)
    if (secrets !== 0) return secrets
    const surfaces = await runS119SurfaceGates(cargoLease.context)
    if (surfaces !== 0) return surfaces
    const bridge = await runS142BridgeGates(cargoLease.context)
    if (bridge !== 0) return bridge
    // The engine half runs against the binary the gate above just built. An
    // effect that never left TypeScript would not have crossed the boundary
    // this sprint exists to build.
    const engine = await verifyBridgeClient(cargoLease.context)
    const clippy = runRustClippy(cargoLease.context)
    if (clippy !== 0) return clippy

    const bunExecutable = trustedBunExecutable()
    const unitTests = Bun.spawnSync([bunExecutable, "test"], {
      cwd: KERNEL_PACKAGE_DIR,
      env: preparedCargoChildEnvironment(cargoLease.context),
      stdout: "inherit",
      stderr: "inherit",
    })
    if (unitTests.exitCode !== 0) return unitTests.exitCode

    console.log(
      `S142 kernel gate passed: ${contracts.byteLength} generated TS bytes; ${boundary.scannedFiles} guarded package files; ${inventory.capabilities} capabilities in ${inventory.implementations} implementations; ${engine.verified} effect carried from TypeScript across the bridge; ${engine.refusedByCapacity} refused full and ${engine.namedRefusalsOnDeath} refused by name when the host died; one fresh locked fetch; all Cargo checks offline`,
    )
    return 0
  } finally {
    cargoLease.dispose()
  }
}

if (import.meta.main) {
  const exitCode = await runKernelTest()
  if (exitCode !== 0) process.exit(exitCode)
}
