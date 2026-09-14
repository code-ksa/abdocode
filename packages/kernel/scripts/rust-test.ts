import { cargoWorkspaceCommand, withIsolatedCargo, type PreparedCargoContext } from "./contracts"

const ID_STRESS_PARENT_GATE = "ABDO_ID_10M_PARENT_GATE"

export function runRustTests(preparedContext?: PreparedCargoContext) {
  return withIsolatedCargo((context) => {
    const primary = runRustTestsBeforeS105(context)
    return primary === 0 ? runRustClippy(context) : primary
  }, preparedContext)
}

export function runRustTestsBeforeS105(preparedContext?: PreparedCargoContext) {
  return withIsolatedCargo((context) => {
    const normal = runRustNormalTests(context)
    return normal === 0 ? runIdStress(context) : normal
  }, preparedContext)
}

export function runRustNormalTests(preparedContext?: PreparedCargoContext) {
  return withIsolatedCargo(({ cwd, environment }) => {
    return runCommands(cwd, environment, [
      cargoWorkspaceCommand("fmt", "--all", "--", "--check"),
      cargoWorkspaceCommand("test", "--locked", "--offline"),
    ])
  }, preparedContext)
}

export function runIdStress(preparedContext?: PreparedCargoContext) {
  return withIsolatedCargo(({ cwd, environment }) => {
    const gateEnvironment = { ...environment, [ID_STRESS_PARENT_GATE]: createParentGate() }
    return runCommands(
      cwd,
      gateEnvironment,
      [
        cargoWorkspaceCommand(
          "test",
          "--locked",
          "--offline",
          "--release",
          "-p",
          "abdo-contracts",
          "--test",
          "id_10m",
          "id_generator_ten_million_unique",
          "--",
          "--ignored",
          "--exact",
        ),
      ],
    )
  }, preparedContext)
}

export function runRustClippy(preparedContext?: PreparedCargoContext) {
  return withIsolatedCargo(
    ({ cwd, environment }) =>
      runCommands(cwd, environment, [
        cargoWorkspaceCommand(
          "clippy",
          "--locked",
          "--offline",
          "--workspace",
          "--all-targets",
          "--all-features",
          "--",
          "-D",
          "warnings",
        ),
      ]),
    preparedContext,
  )
}

function runCommands(cwd: string, environment: Readonly<Record<string, string>>, commands: readonly string[][]) {
  for (const command of commands) {
    const result = Bun.spawnSync(command, {
      cwd,
      env: environment,
      stdout: "inherit",
      stderr: "inherit",
    })
    if (result.exitCode !== 0) return result.exitCode
  }
  return 0
}

function createParentGate() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

if (import.meta.main) {
  const exitCode = runRustTests()
  if (exitCode !== 0) process.exit(exitCode)
}
