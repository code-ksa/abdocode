import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  assertKernelBoundaryWorkflow,
  assertNoCargoConfigurationPaths,
  assertNoRetiredProbeConsumers,
  assertS104ContractsBoundary,
  assertS105CargoIdentity,
  assertS105JournalCapabilities,
  assertStaticBoundarySources,
  listBoundarySourceFiles,
  validateCargoMetadata,
  validateCargoLock,
  verifyBoundaryGuards,
  type BoundarySource,
} from "../scripts/guard"
import {
  assertPreparedCargoContext,
  cargoCommand,
  CARGO_VERSION_IDENTITY,
  RUST_HOST,
  RUST_TOOLCHAIN,
  RUST_VERSION,
  RUSTC_VERSION_IDENTITY,
  sanitizedCargoEnvironment,
  trustedRustToolchainIdentity,
  validateRustToolchainPreflight,
  validatePreparedCargoDescriptor,
  type PreparedCargoContext,
} from "../scripts/contracts"
import { validateS105JournalGateOutput } from "../scripts/s105-journal-test"

let sources: BoundarySource[] = []
let workflowSource = ""

beforeAll(async () => {
  sources = await loadSources()
  workflowSource = await Bun.file(
    join(KERNEL_PACKAGE_DIR, "..", "..", ".github", "workflows", "kernel-boundary.yml"),
  ).text().then((source) => source.replaceAll("\r\n", "\n"))
})

describe("S104 canonical contract boundary", () => {
  test("guards the exact S104 contracts and S105 journal Cargo closure", async () => {
    const result = await verifyBoundaryGuards()
    expect(result.dependencyClosure.packages).toHaveLength(33)
    expect(result.dependencyClosure.packages.slice(0, 4)).toEqual([
      {
        name: "abdo-authority",
        version: "0.1.0",
        source: null,
        dependencies: 3,
        targets: ["abdo_authority", "authority", "authority_sweep"],
      },
      {
        name: "abdo-contracts",
        version: "0.1.0",
        source: null,
        dependencies: 0,
        targets: [
          "abdo-contracts-codegen",
          "abdo_contracts",
          "codegen",
          "golden",
          "id_10m",
          "strict_mutations",
        ],
      },
      {
        name: "abdo-evidence",
        version: "0.1.0",
        source: null,
        dependencies: 2,
        targets: ["abdo_evidence"],
      },
      {
        name: "abdo-journal",
        version: "0.1.0",
        source: null,
        dependencies: 3,
        targets: [
          "abdo-journal-test-child",
          "abdo_journal",
          "compaction",
          "journal",
          "migration_atomicity",
          "recovery_10k",
          "recovery_integrity",
          "restore_100k",
        ],
      },
    ])
    expect(result.dependencyClosure.resolveNodes).toHaveLength(33)
    expect(result.dependencyClosure.packages.filter((entry) => entry.source !== null)).toHaveLength(23)
    expect(result.s104ContractsBoundary).toMatchObject({
      generatedFile: "src/generated/contracts.ts",
      modelCognitionMatches: 0,
      privilegedEffectMatches: 0,
      externalRustImports: 0,
    })
    expect(result.s104ContractsBoundary.retiredProbePaths).toContain("src/protocol.ts")
    expect(result.s106ReducerPurity).toEqual({ libraryFiles: 5, hashContainers: 0, clockSites: 0 })
    expect(result.s113AuthorityBoundary).toEqual({ libraryFiles: 5, retiredAdapterMatches: 0 })
    // One edge into authorisation, and it is the clearance.
    expect(result.s114PolicyBoundary).toEqual({ intoAuthorized: 1 })
    // Full, partial, unavailable — not a boolean wearing a hat.
    expect(result.s115BrokerBoundary).toEqual({ enforcementVerdicts: 3 })
    // A copy, not a view: nothing registered mid-step can reach it.
    expect(result.s116DisclosureBoundary).toEqual({ snapshotOwnsEntries: true })
    // The worker links only contracts, runtime facade and the canonical tools owner.
    expect(result.s117WorkerBoundary).toEqual({ workerDependencies: 3 })
    // No field a secret could sit in, so absence is a design property.
    expect(result.s118SecretBoundary).toEqual({ leaseMaterialFields: 0 })
    // Three counters, because they fail differently.
    expect(result.s119SurfaceBoundary).toEqual({ surfaceGenerations: 3 })
    expect(result.s107RuntimeBoundary).toEqual({
      libraryFiles: 14,
      adapterCallSites: 1,
      hostCapabilities: 0,
      reconcilerDispatchSites: 0,
      stagedConfigApplySites: 1,
      mailboxEnqueueSites: 1,
      inputChannels: 6,
      schedulerClockSites: 0,
      budgetChargeSites: 1,
    })
  }, 30_000)

  test("contract source mutations fail closed", () => {
    expect(assertS104ContractsBoundary(sources).rustFiles).toEqual([
      "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
      "crates/abdo-contracts/src/codegen.rs",
      "crates/abdo-contracts/src/generator.rs",
      "crates/abdo-contracts/src/lib.rs",
      "crates/abdo-contracts/src/schema.rs",
      "crates/abdo-contracts/src/schema_macros.rs",
      "crates/abdo-contracts/src/wire.rs",
      "crates/abdo-contracts/tests/codegen.rs",
      "crates/abdo-contracts/tests/golden.rs",
      "crates/abdo-contracts/tests/id_10m.rs",
      "crates/abdo-contracts/tests/strict_mutations.rs",
    ])

    for (const mutation of [
      { code: "\nstruct ModelPlanner;\n", message: "model or cognition" },
      { code: "\nfn network() { let _ = std::net::TcpStream::connect; }\n", message: "process or network" },
      { code: "\nunsafe fn escape() {}\n", message: "unsafe code" },
      { code: "\nuse mystery_contracts::Payload;\n", message: "external Rust import root" },
    ]) {
      const changed = appendSource(sources, "crates/abdo-contracts/src/schema.rs", mutation.code)
      expect(() => assertS104ContractsBoundary(changed)).toThrow(mutation.message)
    }

    for (const path of [
      "crates/abdo-contracts/src/lib.rs",
      "crates/abdo-contracts/src/schema.rs",
      "crates/abdo-contracts/src/wire.rs",
    ]) {
      const changed = appendSource(sources, path, "\nfn leak() { let _ = std::fs::read; }\n")
      expect(() => assertS104ContractsBoundary(changed)).toThrow("privileged, process or network capability")
    }

    const codegenNetwork = appendSource(
      sources,
      "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
      "\nfn leak() { let _ = std::net::TcpStream::connect; }\n",
    )
    expect(() => assertS104ContractsBoundary(codegenNetwork)).toThrow("network, subprocess")

    const codegenSubprocess = appendSource(
      sources,
      "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
      '\nfn leak() { let _ = std::process::Command::new("cmd"); }\n',
    )
    expect(() => assertS104ContractsBoundary(codegenSubprocess)).toThrow("network, subprocess")

    const extraStressSpawn = appendSource(
      sources,
      "crates/abdo-contracts/tests/id_10m.rs",
      "\nfn extra(child: &mut std::process::Command) { let _ = child.spawn(); }\n",
    )
    expect(() => assertS104ContractsBoundary(extraStressSpawn)).toThrow("self-spawn site count drifted")

    const aliasedStressProcess = appendSource(
      sources,
      "crates/abdo-contracts/tests/id_10m.rs",
      '\ntype HiddenCommand = ProcessCommand;\nfn hidden_process() { let _ = HiddenCommand::new("cmd").status(); }\n',
    )
    expect(() => assertS104ContractsBoundary(aliasedStressProcess)).toThrow("process execution surface")

    for (const mutation of [
      { code: "\nuse std as host;\nfn escape() { let _ = host::fs::read; }\n", message: "namespace alias" },
      { code: "\nuse std as κ;\nfn escape_unicode() { let _ = κ::fs::read; }\n", message: "namespace alias" },
      { code: "\nextern crate std as host;\n", message: "namespace alias" },
      { code: "\nuse std::*;\n", message: "wildcard import" },
      { code: "\nuse std::{self as host};\n", message: "namespace alias" },
      { code: "\nuse ::std::{fs};\nfn escape_group() { let _ = fs::read; }\n", message: "privileged" },
      { code: '\ninclude!("outside.rs");\n', message: "source inclusion" },
      { code: '\nconst LEAK: &[u8] = include_bytes!("outside.bin");\n', message: "source inclusion" },
      { code: '\n#[path = "outside.rs"] mod outside;\n', message: "source inclusion" },
      {
        code: "\nmacro_rules! indirect { ($reader:ident, $file:literal) => { $reader!($file) }; }\n",
        message: "macro_rules surface",
      },
    ]) {
      const changed = appendSource(sources, "crates/abdo-contracts/src/schema.rs", mutation.code)
      expect(() => assertS104ContractsBoundary(changed)).toThrow(mutation.message)
    }

    const codegenAlias = appendSource(
      sources,
      "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
      "\nuse std::fs as hidden_fs;\nfn alias_escape() { let _ = hidden_fs::read; }\n",
    )
    expect(() => assertS104ContractsBoundary(codegenAlias)).toThrow("namespace alias")

    for (const mutation of ["$reader!($file);", "#[$attr = $file] mod injected;"]) {
      const macroIndirection = replaceSource(
        sources,
        "crates/abdo-contracts/src/schema_macros.rs",
        "macro_rules! schema_rule_reason {",
        `macro_rules! schema_rule_reason { ${mutation}`,
      )
      expect(() => assertS104ContractsBoundary(macroIndirection)).toThrow("macro indirection")
    }

    const spoofedGolden = replaceSource(
      sources,
      "crates/abdo-contracts/tests/golden.rs",
      'include_bytes!("../test/fixtures/cancel-command-v1.bin")',
      'include_bytes!("../../../../outside.bin") /* include_bytes!("../test/fixtures/cancel-command-v1.bin") */',
    )
    expect(() => assertS104ContractsBoundary(spoofedGolden)).toThrow("golden fixture inclusion surface drifted")

    const weakened = replaceSource(
      sources,
      "crates/abdo-contracts/src/lib.rs",
      "#![forbid(unsafe_code)]",
      "#![deny(unsafe_code)]",
    )
    expect(() => assertS104ContractsBoundary(weakened)).toThrow("exactly one forbid(unsafe_code)")
  })

  test("generated ownership and exact source surface fail closed", () => {
    const editedHeader = replaceSource(
      sources,
      "src/generated/contracts.ts",
      "// @generated by abdo-contracts-codegen; DO NOT EDIT.",
      "// hand edited",
    )
    expect(() => assertS104ContractsBoundary(editedHeader)).toThrow("read-only header")

    const widenedRoot = replaceSource(
      sources,
      "src/index.ts",
      'export * from "./control"',
      'export * from "./control"\nexport * from "./somewhere-else"',
    )
    expect(() => assertS104ContractsBoundary(widenedRoot)).toThrow(
      "root must export exactly the contract facade, the control client, the approval gate and the host client",
    )

    const handwritten = replaceSource(
      sources,
      "src/control.ts",
      "export const DEFAULT_CLIENT_CAPACITY = 64",
      "export const DEFAULT_CLIENT_CAPACITY = 64\nexport interface Command {}",
    )
    expect(() => assertS104ContractsBoundary(handwritten)).toThrow("handwritten contract duplicate")

    const extra = [...sources, { path: "src/generated/duplicate.ts", source: "export type Command = unknown" }]
    expect(() => assertStaticBoundarySources(extra)).toThrow("source allowlist drifted")
  })

  test("TypeScript capability and manifest mutations fail closed", () => {
    const egress = appendSource(sources, "scripts/contracts.ts", "\nconst leak = fetch\nvoid leak\n")
    expect(() => assertStaticBoundarySources(egress)).toThrow("network or unapproved process capability")

    const dynamicCode = appendSource(
      sources,
      "scripts/contracts.ts",
      '\nconst module = import("./untrusted")\nvoid module\n',
    )
    expect(() => assertStaticBoundarySources(dynamicCode)).toThrow("dynamic code capability")

    const templateEgress = appendSource(
      sources,
      "scripts/contracts.ts",
      ["\nconst value = `", "${", "fet", "ch", "}", "`\nvoid value\n"].join(""),
    )
    expect(() => assertStaticBoundarySources(templateEgress)).toThrow("network or unapproved process capability")

    const computedProcessExit = appendSource(
      sources,
      "scripts/contracts.ts",
      '\nReflect.get(globalThis, "process").exit(0)\n',
    )
    expect(() => assertStaticBoundarySources(computedProcessExit)).toThrow("ambient global capability escape")

    const oldExport = replaceSource(
      sources,
      "package.json",
      '"./contracts": "./src/contracts.ts"',
      '"./contracts": "./src/contracts.ts", "./probe": "./src/protocol.ts"',
    )
    expect(() => assertStaticBoundarySources(oldExport)).toThrow("contract export surface drifted")

    const shortenedStress = replaceSource(
      sources,
      "scripts/rust-test.ts",
      "const gateEnvironment = { ...environment, [ID_STRESS_PARENT_GATE]: createParentGate() }",
      "// mutation removed the forced parent gate",
    )
    expect(() => assertStaticBoundarySources(shortenedStress)).toThrow("Rust gate or sanitized environment shape")

    const shortenedStressCommand = replaceSource(
      sources,
      "scripts/rust-test.ts",
      '        "--exact",',
      '        "--nocapture",',
    )
    expect(() => assertStaticBoundarySources(shortenedStressCommand)).toThrow(
      "Rust gate or sanitized environment shape",
    )

    const inheritedChild = replaceSource(
      sources,
      "scripts/contracts.ts",
      '  "COMSPEC",',
      '  "ABDO_ID_10M_CHILD_INDEX",\n  "COMSPEC",',
    )
    expect(() => assertStaticBoundarySources(inheritedChild)).toThrow("Cargo environment allowlist drifted")

    const secondFetch = replaceSource(
      sources,
      "scripts/contracts.ts",
      'const cargoFetchResult = Bun.spawnSync(cargoWorkspaceCommand("fetch", "--locked"), {',
      'cargoWorkspaceCommand("fetch", "--locked")\n  const cargoFetchResult = Bun.spawnSync(cargoWorkspaceCommand("fetch", "--locked"), {',
    )
    expect(() => assertStaticBoundarySources(secondFetch)).toThrow("locked fetch")

    for (const [before, after] of [
      ["const cargoLockBeforeFetch = cargoLockSha256()", "const cargoLockBeforeFetch = \"unverified\""],
      [
        "if (cargoLockAfterFetch !== cargoLockBeforeFetch)",
        "if (false && cargoLockAfterFetch !== cargoLockBeforeFetch)",
      ],
      ["assertFetchedCargoHome(cargoHome)", "// skipped Cargo-home verification"],
      [
        '"win32:x64": "x86_64-pc-windows-msvc"',
        '"win32:x64": "x86_64-pc-windows-gnu"',
      ],
    ]) {
      const changed = replaceSource(sources, "scripts/contracts.ts", before!, after!)
      expect(() => assertStaticBoundarySources(changed)).toThrow("prepared Cargo")
    }

    const ambientCompiler = replaceSource(
      sources,
      "scripts/contracts.ts",
      '  "COMSPEC",',
      '  "CC",\n  "COMSPEC",',
    )
    expect(() => assertStaticBoundarySources(ambientCompiler)).toThrow("Cargo environment allowlist drifted")

    const duplicateMasterContext = replaceSource(
      sources,
      "scripts/kernel-test.ts",
      "const cargoLease = prepareCargoContext()",
      "prepareCargoContext()\n  const cargoLease = prepareCargoContext()",
    )
    expect(() => assertStaticBoundarySources(duplicateMasterContext)).toThrow("master Cargo gate call order")

    const zeroedMasterExit = replaceSource(
      sources,
      "scripts/kernel-test.ts",
      "process.exit(exitCode)",
      "process.exit(exitCode * 0)",
    )
    expect(() => assertStaticBoundarySources(zeroedMasterExit)).toThrow("master executable control-flow digest")

    const pathLookedUpBun = replaceSource(
      sources,
      "scripts/kernel-test.ts",
      'Bun.spawnSync([bunExecutable, "test"]',
      'Bun.spawnSync(["bun", "test"]',
    )
    expect(() => assertStaticBoundarySources(pathLookedUpBun)).toThrow(/master Cargo gate call order|PATH lookup/)

    const unverifiedBunExecutable = replaceSource(
      sources,
      "scripts/contracts.ts",
      "const requestedPath = resolve(process.execPath)",
      'const requestedPath = resolve("bun")',
    )
    expect(() => assertStaticBoundarySources(unverifiedBunExecutable)).toThrow("prepared Cargo")

    const pathLookedUpCargo = replaceSource(
      sources,
      "scripts/contracts.ts",
      'return [toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "cargo", command, ...args]',
      'return ["cargo", command, ...args]',
    )
    expect(() => assertStaticBoundarySources(pathLookedUpCargo)).toThrow(/prepared Cargo|PATH lookup/)

    const inheritedRustupHome = replaceSource(
      sources,
      "scripts/contracts.ts",
      "environment.RUSTUP_HOME = trustedRustToolchainIdentity().rustupHome",
      'environment.RUSTUP_HOME = source.RUSTUP_HOME ?? "forged"',
    )
    expect(() => assertStaticBoundarySources(inheritedRustupHome)).toThrow("prepared Cargo")

    const acceptedRustupSymlink = replaceSource(
      sources,
      "scripts/contracts.ts",
      "!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()",
      "!requestedIdentity.isFile()",
    )
    expect(() => assertStaticBoundarySources(acceptedRustupSymlink)).toThrow("symlink checks drifted")

    const skippedToolchainIdentity = replaceSource(
      sources,
      "scripts/contracts.ts",
      "validateRustToolchainPreflight(rustc, cargo)",
      "// toolchain identity acceptance skipped",
    )
    expect(() => assertStaticBoundarySources(skippedToolchainIdentity)).toThrow("prepared Cargo")

    const reusedGateEnvironment = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      "for (const marker of family.parentEnvironments) delete gateEnvironment[marker]",
      "// sibling parent markers were retained",
    )
    expect(() => assertStaticBoundarySources(reusedGateEnvironment)).toThrow("runner shape drifted")

    const silentGateFailure = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      '    reportFailedGate(family, gate, "test", command, result)\n',
      "",
    )
    expect(() => assertStaticBoundarySources(silentGateFailure)).toThrow("runner shape drifted")

    const unreportedGateSilence = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      '"the child produced no output at all"',
      '""',
    )
    expect(() => assertStaticBoundarySources(unreportedGateSilence)).toThrow("runner shape drifted")

    const diagnosticAfterRelay = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      '    reportFailedGate(family, gate, "test", command, result)\n    if (result.exitCode !== 0) return result.exitCode',
      '    if (result.exitCode !== 0) return result.exitCode\n    reportFailedGate(family, gate, "test", command, result)',
    )
    expect(() => assertStaticBoundarySources(diagnosticAfterRelay)).toThrow(
      "name a failing Cargo gate before relaying its exit code",
    )

    const missingJournalMarkers = replaceSource(
      sources,
      "scripts/s105-journal-test.ts",
      "const JOURNAL_PARENT_GATES = [CRASH_PARENT_GATE, MIGRATION_PARENT_GATE, RESTORE_PARENT_GATE] as const",
      "const JOURNAL_PARENT_GATES = [CRASH_PARENT_GATE] as const",
    )
    expect(() => assertStaticBoundarySources(missingJournalMarkers)).toThrow("exact-gate harness")

    const weakenedReducerEvidence = replaceSource(
      sources,
      "scripts/s106-reducer-test.ts",
      "transitions !== 1_000_000 || accepted + rejected !== transitions",
      "false",
    )
    expect(() => assertStaticBoundarySources(weakenedReducerEvidence)).toThrow("exact-gate harness")

    const unrefusedReducerRun = replaceSource(
      sources,
      "scripts/s106-reducer-test.ts",
      "if (rejected < 1 || accepted < 1 || effects < 1)",
      "if (false)",
    )
    expect(() => assertStaticBoundarySources(unrefusedReducerRun)).toThrow("exact-gate harness")

    for (const [before, after] of [
      ["use std::collections::BTreeMap;", "use std::collections::HashMap;"],
      ["pub struct KernelState {", "use std::time::Instant;\npub struct KernelState {"],
    ] as const) {
      const impureReducer = replaceSource(sources, "crates/abdo-kernel/src/state.rs", before, after)
      expect(() => assertStaticBoundarySources(impureReducer)).toThrow(/hash container|clock, host, task/)
    }

    const wrongJournalOrder = replaceSource(
      sources,
      "scripts/s105-journal-test.ts",
      'testTarget: "migration_atomicity"',
      'testTarget: "recovery_10k"',
    )
    expect(() => assertStaticBoundarySources(wrongJournalOrder)).toThrow(/exact-gate harness|declared order/)

    const disabledJournalFeatures = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      'const featureArguments = gate.features === undefined ? [] : ["--features", gate.features]',
      "const featureArguments: string[] = []",
    )
    expect(() => assertStaticBoundarySources(disabledJournalFeatures)).toThrow("runner shape drifted")

    const swallowedJournalFailure = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      "if (result.exitCode !== 0) return result.exitCode",
      "if (result.exitCode !== 0) return 0",
    )
    expect(() => assertStaticBoundarySources(swallowedJournalFailure)).toThrow("runner shape drifted")

    const commentForgedJournalSuccess = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      '    if (result.exitCode !== 0) return result.exitCode\n    family.validate(gate.name, `${result.stdout}\\n${result.stderr}`)\n    return 0',
      '    if (result.exitCode !== 0) return 0\n    // if (result.exitCode !== 0) return result.exitCode\n    // family.validate(gate.name, `${result.stdout}\\n${result.stderr}`)\n    return 0',
    )
    expect(() => assertStaticBoundarySources(commentForgedJournalSuccess)).toThrow(
      "Cargo result and acceptance-evidence flow",
    )

    const unboundedJournalGate = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      "const observed = await awaitExitWithin(child, gate.timeoutMs)",
      "const observed = await awaitExitWithin(child, Number.POSITIVE_INFINITY)",
    )
    expect(() => assertStaticBoundarySources(unboundedJournalGate)).toThrow("runner shape drifted")

    const reorderedBarrier = replaceSource(
      sources,
      "crates/abdo-runtime/src/supervisor.rs",
      "pub fn commit_dispatch(",
      "pub fn zz_commit_dispatch_moved_after_invoke(",
    )
    expect(() => assertStaticBoundarySources(reorderedBarrier)).toThrow(
      /dispatch barrier|runtime source surface|control-flow/,
    )

    const openedDispatch = replaceSource(
      sources,
      "crates/abdo-runtime/src/supervisor.rs",
      'if !cfg!(feature = "effectful-dispatch") {',
      "if false {",
    )
    expect(() => assertStaticBoundarySources(openedDispatch)).toThrow("feature-gated")

    const dispatchingReconciler = replaceSource(
      sources,
      "crates/abdo-runtime/src/reconcile.rs",
      "use crate::supervisor::{EffectSupervisor, Settlement};",
      "use crate::supervisor::{Dispatcher, EffectSupervisor, Settlement};",
    )
    expect(() => assertStaticBoundarySources(dispatchingReconciler)).toThrow("way to dispatch")

    const escalationCountedAsDone = replaceSource(
      sources,
      "crates/abdo-runtime/src/phase.rs",
      "Self::Verified | Self::Compensated | Self::ApprovalRefused",
      "Self::Verified | Self::Compensated | Self::ApprovalRefused | Self::Escalated",
    )
    expect(() => assertStaticBoundarySources(escalationCountedAsDone)).toThrow(
      "never count as a resolved effect",
    )

    // S114. Every way to widen an authority, each expected by name so that one
    // early check cannot satisfy the whole set.
    const harmlessByDefault = replaceSource(
      sources,
      "crates/abdo-policy/src/lib.rs",
      ".unwrap_or(Risk::R4)",
      ".unwrap_or(Risk::R0)",
    )
    expect(() => assertStaticBoundarySources(harmlessByDefault)).toThrow(
      "no longer defaults to the highest risk band",
    )

    const standingYesForTheIrreversible = replaceSource(
      sources,
      "crates/abdo-policy/src/lib.rs",
      "!matches!(self, Self::R4)",
      "!matches!(self, Self::R0)",
    )
    expect(() => assertStaticBoundarySources(standingYesForTheIrreversible)).toThrow(
      "accepts a standing approval",
    )

    const allowanceBeforeDenial = replaceSource(
      sources,
      "crates/abdo-policy/src/lib.rs",
      "if self.denied.contains(request.operation_digest.as_bytes()) {",
      "if self.allowed.contains(request.operation_digest.as_bytes()) {",
    )
    expect(() => assertStaticBoundarySources(allowanceBeforeDenial)).toThrow(
      "no longer checked before an allowance",
    )

    const approvalTrustsItself = replaceSource(
      sources,
      "crates/abdo-policy/src/lib.rs",
      "if approval.binding != expected {",
      "if false {",
    )
    expect(() => assertStaticBoundarySources(approvalTrustsItself)).toThrow(
      "without recomputing what it was granted for",
    )

    const reusableApproval = replaceSource(
      sources,
      "crates/abdo-policy/src/lib.rs",
      "if !self.consumed.insert(*expected.as_bytes()) {",
      "if false {",
    )
    expect(() => assertStaticBoundarySources(reusableApproval)).toThrow("no longer one-shot")

    const silenceApproves = replaceSource(
      sources,
      "crates/abdo-runtime/src/gatekeeper.rs",
      "let Some(approval) = answer else {",
      "let approval = answer.unwrap_or(forged()); if false {",
    )
    expect(() => assertStaticBoundarySources(silenceApproves)).toThrow(
      "no longer takes the refusal path",
    )

    const unattendedPortSaysYes = replaceSource(
      sources,
      "crates/abdo-runtime/src/gatekeeper.rs",
      "impl ApprovalPort for NoOperator {",
      "impl ApprovalPort for SomeoneElse {",
    )
    expect(() => assertStaticBoundarySources(unattendedPortSaysYes)).toThrow(
      "no longer answers nothing",
    )

    const engineApprovesWithoutAHandler = replaceSource(
      sources,
      "src/approval.ts",
      'if (this.#handler === undefined) return this.#refuse("no-handler")',
      "if (this.#handler !== undefined) void 0",
    )
    expect(() => assertStaticBoundarySources(engineApprovesWithoutAHandler)).toThrow(
      "denies when nobody answers",
    )

    // The one that matters most: a second door into authorisation.
    const secondDoorToAuthorisation = replaceSource(
      sources,
      "crates/abdo-runtime/src/phase.rs",
      "(Self::Prepared, Self::ApprovalAsked)",
      "(Self::Prepared, Self::Authorized)",
    )
    expect(() => assertStaticBoundarySources(secondDoorToAuthorisation)).toThrow(
      "reachable other than through a clearance",
    )

    // And a refusal that can be walked forward, which is not a refusal.
    const refusalWalkedForward = replaceSource(
      sources,
      "crates/abdo-runtime/src/phase.rs",
      "(Self::ApprovalAsked, Self::Cleared)",
      "(Self::ApprovalRefused, Self::Cleared)",
    )
    expect(() => assertStaticBoundarySources(refusalWalkedForward)).toThrow(
      "refused effect can still move somewhere",
    )

    // S115. The one the plan names outright: a boolean coming back to attest
    // isolation, in the contract and in the broker.
    const booleanInTheContract = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "            enforcement: Enforcement,",
      "            enforcement: Enforcement,\n            sandboxed: bool,",
    )
    expect(() => assertStaticBoundarySources(booleanInTheContract)).toThrow(
      "the contract attests isolation with a boolean",
    )

    const booleanInTheBroker = replaceSource(
      sources,
      "crates/abdo-tools/src/broker.rs",
      "    enforcement: Enforcement,\n}",
      "    enforcement: Enforcement,\n    sandboxed: bool,\n}",
    )
    expect(() => assertStaticBoundarySources(booleanInTheBroker)).toThrow(
      "the broker attests isolation with a boolean",
    )

    // Two verdicts is a boolean with extra steps.
    const twoWayVerdict = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "            Unavailable = 3,",
      "            NotUnavailable = 3,",
    )
    expect(() => assertStaticBoundarySources(twoWayVerdict)).toThrow(
      "no longer three-way",
    )

    const recoveryLeavesTheClass = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "        MutatingEffect {\n            recovery: RecoveryPlan,\n        }",
      "        MutatingEffect {\n            note_digest: Digest,\n        }",
    )
    expect(() => assertStaticBoundarySources(recoveryLeavesTheClass)).toThrow(
      "MutatingEffect no longer carries its recovery",
    )

    const compensatingTheIrreversible = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "        IrreversibleEffect {\n            evidence_operation_digest: Digest,\n        }",
      "        IrreversibleEffect {\n            recovery: RecoveryPlan,\n            evidence_operation_digest: Digest,\n        }",
    )
    expect(() => assertStaticBoundarySources(compensatingTheIrreversible)).toThrow(
      "claims a compensation it cannot have",
    )

    const leaseReachesThePolicy = replaceSource(
      sources,
      "crates/abdo-tools/src/broker.rs",
      "pub struct ToolLease {\n    operation_digest: Digest,",
      "pub struct ToolLease {\n    policy: abdo_authority::Policy,\n    operation_digest: Digest,",
    )
    expect(() => assertStaticBoundarySources(leaseReachesThePolicy)).toThrow(
      "lease reaches the policy",
    )

    const handlerCheckedAfterStoring = replaceSource(
      sources,
      "crates/abdo-tools/src/broker.rs",
      "        if !self.handlers.contains_key(spec.handler_digest.as_bytes()) {\n            return Err(RegistrationError::NoHandler { tool_id });\n        }",
      "",
    )
    expect(() => assertStaticBoundarySources(handlerCheckedAfterStoring)).toThrow(
      "schema with no handler can reach the catalog",
    )

    // S116. The one the whole sprint rests on: a snapshot that borrows is a
    // view, and a view can be moved under the step holding it.
    const snapshotBorrows = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      "pub struct CatalogSnapshot {",
      "pub struct CatalogSnapshot<'catalog> {\n    borrowed: &'catalog (),",
    )
    expect(() => assertStaticBoundarySources(snapshotBorrows)).toThrow(
      "borrows from the catalog",
    )

    const snapshotUnordered = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      "    entries: BTreeMap<u128, Entry>,\n}",
      "    entries: Vec<Entry>,\n}",
    )
    expect(() => assertStaticBoundarySources(snapshotUnordered)).toThrow(
      "no longer owns an ordered copy",
    )

    const searchGrewAClock = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      "use std::collections::BTreeMap;",
      "use std::collections::BTreeMap;\nuse std::collections::HashMap;",
    )
    expect(() => assertStaticBoundarySources(searchGrewAClock)).toThrow(
      "clock or a hash container",
    )

    const searchIgnoresTheBudget = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      ".take(query.limit)",
      ".take(usize::MAX)",
    )
    expect(() => assertStaticBoundarySources(searchIgnoresTheBudget)).toThrow(
      "no longer respects a disclosure budget",
    )

    const briefCarriesTheSchema = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      "pub struct Brief {\n    pub tool_id: ToolId,",
      "pub struct Brief {\n    pub input_schema_digest: Digest,\n    pub tool_id: ToolId,",
    )
    expect(() => assertStaticBoundarySources(briefCarriesTheSchema)).toThrow(
      "belongs to the full schema",
    )

    // A fifth token estimator, which is the defect class this codebase pays for
    // most. The divisor lives in one file in this product; a second one here
    // would let a correct local fix become a system-wide disagreement.
    const secondTokenEstimator = replaceSource(
      sources,
      "crates/abdo-tools/src/disclosure.rs",
      "encoded_len(&self.spec) * 2",
      "encoded_len(&self.spec) / 3",
    )
    expect(() => assertStaticBoundarySources(secondTokenEstimator)).toThrow(
      "grew its own token estimate",
    )

    const stepMergesForeignDisclosures = replaceSource(
      sources,
      "src/catalog.ts",
      "if (!sameSnapshot(disclosure.snapshot, this.#snapshot)) {",
      "if (false) {",
    )
    expect(() => assertStaticBoundarySources(stepMergesForeignDisclosures)).toThrow(
      "merges disclosures from other snapshots",
    )

    const stepTruncatesInsteadOfRefusing = replaceSource(
      sources,
      "src/catalog.ts",
      "if (this.#disclosed.size + disclosure.toolIds.length > this.#budget) {",
      "if (this.#disclosed.size + disclosure.toolIds.length < 0) {",
    )
    expect(() => assertStaticBoundarySources(stepTruncatesInsteadOfRefusing)).toThrow(
      "no longer refuses past its budget",
    )

    // S117. The worker may depend only on the three reviewed owners and may
    // perform no effect outside the broker.
    const workerReachesAuthority = replaceSource(
      sources,
      "bins/abdo-tool-worker/src/main.rs",
      "let mut input = Vec::new();",
      "let mut input = Vec::new();\n    let _ = abdo_authority::Authority::new;",
    )
    expect(() => assertStaticBoundarySources(workerReachesAuthority)).toThrow(
      "tool worker reached for abdo_authority",
    )

    const workerRunsSomething = replaceSource(
      sources,
      "bins/abdo-tool-worker/src/main.rs",
      "let spec: ToolSpec = decode_frame(&input).map_err(|error| error.to_string())?;",
      `let _ = std::process::Command::new("sh");\n    let spec: ToolSpec = decode_frame(&input).map_err(|error| error.to_string())?;`,
    )
    expect(() => assertStaticBoundarySources(workerRunsSomething)).toThrow(
      "performs an effect outside the broker",
    )

    const workerReadsWithoutABound = replaceSource(
      sources,
      "bins/abdo-tool-worker/src/main.rs",
      ".take(MAX_FRAME_BYTES as u64 + 1)",
      ".take(u64::MAX)",
    )
    expect(() => assertStaticBoundarySources(workerReadsWithoutABound)).toThrow(
      "reads a frame without a bound",
    )

    const inventoryLosesItsBroker = replaceSource(
      sources,
      "inventory/tool-surface.json",
      '"name": "rust-tool-broker"',
      '"name": "missing-tool-broker"',
    )
    expect(() => assertStaticBoundarySources(inventoryLosesItsBroker)).toThrow(
      "canonical tool owners",
    )

    const inventoryStopsCountingOmissions = replaceSource(
      sources,
      "scripts/inventory.ts",
      "if (listedIds.size !== shippedIds.size || [...shippedIds].some((id) => !listedIds.has(id))) {",
      "if (false) {",
    )
    expect(() => assertStaticBoundarySources(inventoryStopsCountingOmissions)).toThrow(
      "no longer fails when a shipped tool is missing",
    )

    // S118. The mechanism is that there is nowhere to put a secret, so the
    // mutations are the places one could be put.
    const leaseHoldsMaterial = replaceSource(
      sources,
      "crates/abdo-runtime/src/vault.rs",
      "    scope: Scope,\n    issued_at_ms: u64,",
      "    scope: Scope,\n    material: String,\n    issued_at_ms: u64,",
    )
    expect(() => assertStaticBoundarySources(leaseHoldsMaterial)).toThrow(
      "grew a field that could hold material",
    )

    const vaultAcceptsMaterial = replaceSource(
      sources,
      "crates/abdo-runtime/src/vault.rs",
      "        consumer_digest: Digest,\n        scope: Scope,",
      "        consumer_digest: Digest,\n        material: &[u8],\n        scope: Scope,",
    )
    expect(() => assertStaticBoundarySources(vaultAcceptsMaterial)).toThrow(
      "which is the one thing it must not accept",
    )

    const leaseVouchesForItsHolder = replaceSource(
      sources,
      "crates/abdo-runtime/src/vault.rs",
      "if lease.consumer_digest != presentation.consumer_digest {",
      "if false {",
    )
    expect(() => assertStaticBoundarySources(leaseVouchesForItsHolder)).toThrow(
      "admitted without checking who, where or when",
    )

    // Revocation that walks a list has a halfway point; one number does not.
    const revocationWalksAList = replaceSource(
      sources,
      "crates/abdo-runtime/src/vault.rs",
      "        self.generation += 1;\n        self.generation",
      "        for _ in 0..1 {}\n        self.leases.clear();\n        self.generation",
    )
    expect(() => assertStaticBoundarySources(revocationWalksAList)).toThrow(
      "walks a list instead of moving one number",
    )

    const handlePrintsItself = replaceSource(
      sources,
      "crates/abdo-runtime/src/vault.rs",
      'formatter.write_str("SecretHandle(…)")',
      "write!(formatter, \"{:?}\", self.0)",
    )
    expect(() => assertStaticBoundarySources(handlePrintsItself)).toThrow(
      "displays its own bytes",
    )

    // S119. The sprint excludes a driver and keeps three counters; both are
    // easy to lose without anything failing.
    const contractGrewADriver = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "        SurfaceGenerations {",
      "        CdpSession {\n            websocket: u64,\n        }\n        rules {}\n\n        SurfaceGenerations {",
    )
    expect(() => assertStaticBoundarySources(contractGrewADriver)).toThrow(
      "surface contract contains a driver",
    )

    const generationsCollapsed = replaceSource(
      sources,
      "crates/abdo-contracts/src/schema.rs",
      "            navigation: u64,\n            window: u64,\n            view: u64,",
      "            navigation: u64,\n            window: u64,",
    )
    expect(() => assertStaticBoundarySources(generationsCollapsed)).toThrow(
      "no longer three",
    )

    const viewNoLongerCompared = replaceSource(
      sources,
      "crates/abdo-runtime/src/surface.rs",
      "if seen.view != current.view {",
      "if false {",
    )
    expect(() => assertStaticBoundarySources(viewNoLongerCompared)).toThrow(
      "view generation is no longer compared",
    )

    // The comparison must use what the caller saw. Reading the registry twice
    // compares a value with itself and admits everything.
    const stalenessReadsItself = replaceSource(
      sources,
      "crates/abdo-runtime/src/surface.rs",
      "let seen = &action.generations;",
      "let seen = &live.generations;",
    )
    expect(() => assertStaticBoundarySources(stalenessReadsItself)).toThrow(
      "decided from the registry rather than from what the caller saw",
    )

    const copyableWriter = replaceSource(
      sources,
      "crates/abdo-runtime/src/session.rs",
      "#[derive(Debug)]\npub struct SessionWriter {",
      "#[derive(Clone, Debug)]\npub struct SessionWriter {",
    )
    expect(() => assertStaticBoundarySources(copyableWriter)).toThrow("writer became copyable")

    const roundAppliesConfig = replaceSource(
      sources,
      "crates/abdo-runtime/src/session.rs",
      "        self.cursor.round = next(self.cursor.round)?;",
      "        if let Some(staged) = self.staged.take() {\n            self.active = staged;\n        }\n        self.cursor.round = next(self.cursor.round)?;",
    )
    expect(() => assertStaticBoundarySources(roundAppliesConfig)).toThrow(
      /retry round can now change|applied from more than one site/,
    )

    const secondChannelEnum = replaceSource(
      sources,
      "crates/abdo-runtime/src/control.rs",
      "pub use abdo_contracts::InputChannel;",
      "pub enum InputChannel { UserFollowup }",
    )
    expect(() => assertStaticBoundarySources(secondChannelEnum)).toThrow(
      "declared its own input channel",
    )

    const resurrectedAdapter = appendSource(
      sources,
      "crates/abdo-authority/src/lib.rs",
      "\npub fn verify_integrity_with() {}\n",
    )
    expect(() => assertStaticBoundarySources(resurrectedAdapter)).toThrow(
      "retired trust adapter survives",
    )

    const pidOnlyIdentity = replaceSource(
      sources,
      "crates/abdo-authority/src/identity.rs",
      "        hasher.update(self.started_at_ms.to_be_bytes());",
      "        // start time dropped",
    )
    expect(() => assertStaticBoundarySources(pidOnlyIdentity)).toThrow(
      "no longer binds both the PID and the start time",
    )

    const unboundedClient = replaceSource(
      sources,
      "src/control.ts",
      "if (this.#queue.length >= this.#capacity) {",
      "if (false) {",
    )
    expect(() => assertStaticBoundarySources(unboundedClient)).toThrow(
      "engine-side client no longer checks its capacity",
    )

    const handRolledDecode = replaceSource(
      sources,
      "src/control.ts",
      "    return decodeInputEnvelope(bytes)",
      "    return new DataView(bytes.buffer) as never",
    )
    expect(() => assertStaticBoundarySources(handRolledDecode)).toThrow(
      "parses frames itself instead of using the codec",
    )

    // S142. The host is the one place in this package allowed a clock, a file
    // and a command line, so every mutation here is a capability creeping past
    // the allowance or the halt moving off the boundary it exists to sit on.
    const hostCanSpawn = replaceSource(
      sources,
      "crates/abdo-runtime/src/host.rs",
      "use std::io::{Read, Write};",
      "use std::io::{Read, Write};\nuse std::process::Command;",
    )
    expect(() => assertStaticBoundarySources(hostCanSpawn)).toThrow(
      "capability beyond its pipe, clock and bindings",
    )

    const hostReadsTheClockTwice = replaceSource(
      sources,
      "crates/abdo-runtime/src/host.rs",
      "    let since_epoch = SystemTime::now()",
      "    let since_epoch = SystemTime::now().max(SystemTime::now())",
    )
    expect(() => assertStaticBoundarySources(hostReadsTheClockTwice)).toThrow(
      "reads the clock in more than one place",
    )

    // A file's length is not this process's to trust.
    const hostReadsWhateverItIsGiven = replaceSource(
      sources,
      "crates/abdo-runtime/src/host.rs",
      ".take(limit.saturating_add(1))",
      ".take(u64::MAX)",
    )
    expect(() => assertStaticBoundarySources(hostReadsWhateverItIsGiven)).toThrow(
      "no longer bounds a read before it performs it",
    )

    // Without the halt there is no way to stand a process in the one gap a
    // crash can land in, and the recovery gate becomes a simulation.
    const hostCannotStopInTheGap = replaceSource(
      sources,
      "crates/abdo-runtime/src/host.rs",
      "    if stop_after_commit {",
      "    if false {",
    )
    expect(() => assertStaticBoundarySources(hostCannotStopInTheGap)).toThrow(
      "no longer stops between the committed dispatch and the adapter",
    )

    // A second copy of the dispatch gate is a gate that is shut in one of them.
    const hostCarriesItsOwnGate = replaceSource(
      sources,
      "crates/abdo-runtime/src/host.rs",
      "    let mut adapter = ReadObject {",
      '    if !cfg!(feature = "effectful-dispatch") {\n        return Ok(Some(declined(intent_id, b"dispatch-disabled")));\n    }\n    let mut adapter = ReadObject {',
    )
    expect(() => assertStaticBoundarySources(hostCarriesItsOwnGate)).toThrow(
      "carries its own copy of the dispatch gate",
    )

    const unboundedHostClient = replaceSource(
      sources,
      "src/host.ts",
      "if (this.#waiting.length >= this.#capacity) {",
      "if (false) {",
    )
    expect(() => assertStaticBoundarySources(unboundedHostClient)).toThrow(
      "host client no longer checks its capacity",
    )

    // Dropping the calls a dead host left behind is the silence the whole
    // three-answer shape exists to prevent.
    const deadHostAnswersNobody = replaceSource(
      sources,
      "src/host.ts",
      "while (this.#waiting.length > 0) {",
      "while (false) {",
    )
    expect(() => assertStaticBoundarySources(deadHostAnswersNobody)).toThrow(
      "no longer answers the calls a dead host left in flight",
    )

    const unboundedMailbox = replaceSource(
      sources,
      "crates/abdo-runtime/src/control.rs",
      "if self.queue.len() >= self.capacity {",
      "if false {",
    )
    expect(() => assertStaticBoundarySources(unboundedMailbox)).toThrow(
      "no longer checks its capacity",
    )

    const sheddableInterrupt = replaceSource(
      sources,
      "crates/abdo-runtime/src/control.rs",
      "    fn is_sheddable(self) -> bool {\n        !matches!(self, Self::PolicyInterrupt)",
      "    fn is_sheddable(self) -> bool {\n        true",
    )
    expect(() => assertStaticBoundarySources(sheddableInterrupt)).toThrow("became sheddable")

    const writersShare = replaceSource(
      sources,
      "crates/abdo-runtime/src/schedule.rs",
      "!matches!((self, other), (Self::Read, Self::Read))",
      "matches!((self, other), (Self::Write, Self::Write)) || false",
    )
    expect(() => assertStaticBoundarySources(writersShare)).toThrow(
      "no longer treats shared reads as the only overlap",
    )

    const frozenRotation = replaceSource(
      sources,
      "crates/abdo-runtime/src/schedule.rs",
      "self.cursor = self.cursor.wrapping_add(1);",
      "self.cursor = 0;",
    )
    expect(() => assertStaticBoundarySources(frozenRotation)).toThrow("a lane can starve")

    const incompleteTreeCleanup = replaceSource(
      sources,
      "scripts/bounded-gate.ts",
      "terminateAndReapProcessTree(child, environment)",
      'child.kill("SIGKILL")',
    )
    expect(() => assertStaticBoundarySources(incompleteTreeCleanup)).toThrow("process-tree cleanup")
    // Each mutation re-scans every guarded file. The budget is explicit
    // because a suite that silently ran out of time would look like a guard
    // that stopped catching things.
  }, 30_000)

  test("Cargo metadata rejects package, target, checksum, feature and graph drift", () => {
    const valid = cargoMetadataFixture()
    expect(validateCargoMetadata(valid).packages[0]?.name).toBe("abdo-authority")
    expect(validateCargoMetadata(valid).packages[1]?.name).toBe("abdo-contracts")
    expect(validateCargoMetadata(valid).packages[2]?.name).toBe("abdo-evidence")

    const contractsIndex = valid.packages.findIndex((entry) => entry.name === "abdo-contracts")
    const journalIndex = valid.packages.findIndex((entry) => entry.name === "abdo-journal")
    const rusqliteIndex = valid.packages.findIndex((entry) => entry.name === "rusqlite")
    const contractsId = valid.packages[contractsIndex]!.id
    const journalId = valid.packages[journalIndex]!.id
    const journalNodeIndex = valid.resolve.nodes.findIndex((entry) => entry.id === journalId)

    const dependency = structuredClone(valid)
    dependency.packages[journalIndex]!.dependencies[1]!.uses_default_features = true
    expect(() => validateCargoMetadata(dependency)).toThrow("direct dependency metadata drifted")

    const graphEdge = structuredClone(valid)
    graphEdge.resolve.nodes[journalNodeIndex]!.dependencies.pop()
    expect(() => validateCargoMetadata(graphEdge)).toThrow("resolve dependency edges drifted")

    const namedEdge = structuredClone(valid)
    namedEdge.resolve.nodes[journalNodeIndex]!.deps[0]!.name = "renamed_contract"
    expect(() => validateCargoMetadata(namedEdge)).toThrow("dependency alias drifted")

    const probe = structuredClone(valid)
    probe.packages[contractsIndex]!.targets.push({
      name: "abdo-kernel-probe",
      src_path: join(KERNEL_PACKAGE_DIR, "src", "main.rs"),
      kind: ["bin"],
      "required-features": [],
      test: true,
      doctest: false,
    })
    expect(() => validateCargoMetadata(probe)).toThrow("retired probe target returned")

    const extraTarget = structuredClone(valid)
    extraTarget.packages[contractsIndex]!.targets.push({
      name: "unreviewed_contract_test",
      src_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts", "tests", "unreviewed.rs"),
      kind: ["test"],
      "required-features": [],
      test: true,
      doctest: false,
    })
    expect(() => validateCargoMetadata(extraTarget)).toThrow("target allowlist drifted")

    const extraPackage = structuredClone(valid)
    extraPackage.packages.push(structuredClone(extraPackage.packages[0]!))
    expect(() => validateCargoMetadata(extraPackage)).toThrow("exactly 33 packages")

    const escaped = structuredClone(valid)
    escaped.packages[contractsIndex]!.targets[0]!.src_path = join(KERNEL_PACKAGE_DIR, "..", "outside.rs")
    expect(() => validateCargoMetadata(escaped)).toThrow("escapes the kernel package")

    const checksum = structuredClone(valid)
    checksum.packages[rusqliteIndex]!.checksum = "0".repeat(64)
    expect(() => validateCargoMetadata(checksum)).toThrow("version, source or checksum drifted")

    const selectedFeature = structuredClone(valid)
    selectedFeature.resolve.nodes[journalNodeIndex]!.features.push("test-hooks")
    expect(() => validateCargoMetadata(selectedFeature)).toThrow("selected feature set drifted")

    const wrongDefaultMember = structuredClone(valid)
    wrongDefaultMember.workspace_default_members = [contractsId]
    expect(() => validateCargoMetadata(wrongDefaultMember)).toThrow("default workspace member allowlist drifted")

    const wrongRoot = structuredClone(valid)
    wrongRoot.resolve.root = contractsId
    expect(() => validateCargoMetadata(wrongRoot)).toThrow("virtual Cargo workspace resolve root drifted")
  })

  test("S105 runner requires one named pass and exact quantitative acceptance evidence", () => {
    const migration = gateOutput(
      "migration_interruption_is_atomic",
      "S105_MIGRATION_ATOMICITY points=24 elapsed_ms=1942",
      "1.94s",
    )
    const restore = gateOutput(
      "restores_hundred_thousand_events_within_two_seconds",
      "S105_RESTORE_100K events=100000 snapshot=90000 tail=10000 fixture_ms=8061 open_ms=1020 restore_ms=20 fold_ms=1 total_ms=1041",
      "9.10s",
    )
    const crash = gateOutput(
      "crash_injection_ten_thousand_process_deaths",
      `S105_RECOVERY_10K injections=10000 lanes=16 phase_counts=[${Array.from({ length: 10 }, () => "1000").join(
        ", ",
      )}] elapsed_ms=210439`,
      "210.44s",
    )
    expect(() => validateS105JournalGateOutput("migration", migration)).not.toThrow()
    expect(() => validateS105JournalGateOutput("restore", restore)).not.toThrow()
    expect(() => validateS105JournalGateOutput("crash10k", crash)).not.toThrow()

    for (const [name, output] of [
      ["migration", migration.replace("running 1 test", "running 0 tests")],
      ["migration", migration.replace("migration_interruption_is_atomic", "renamed_test")],
      ["migration", migration.replace("\nok\n", "\nFAILED\n")],
      ["migration", migration.replace("1 passed", "0 passed")],
      ["restore", restore.replace("tail=10000", "tail=9999")],
      ["restore", restore.replace("total_ms=1041", "total_ms=2001")],
      ["crash10k", crash.replace("injections=10000", "injections=9999")],
      ["crash10k", crash.replace(", 1000] elapsed_ms", "] elapsed_ms")],
      ["crash10k", `${crash}\nrunning 1 test`],
    ] as const) {
      expect(() => validateS105JournalGateOutput(name, output)).toThrow()
    }
  })

  test("S105 manifests and Cargo.lock pin the workspace, features, SQLite and every checksum", () => {
    expect(assertS105CargoIdentity(sources)).toMatchObject({
      workspaceMembers: [
        "crates/abdo-contracts",
        "crates/abdo-journal",
        "crates/abdo-kernel",
        "crates/abdo-authority",
        "crates/abdo-policy",
        "crates/abdo-evidence",
        "crates/abdo-tools",
        "crates/abdo-runtime",
        "bins/abdo-kernel",
        "bins/abdo-tool-worker",
      ],
      journalDependencies: ["abdo-contracts", "rusqlite", "sha2"],
      kernelCoreDependencies: ["abdo-contracts", "sha2"],
      runtimeDependencies: ["abdo-authority", "abdo-contracts", "abdo-evidence", "abdo-journal", "abdo-kernel", "abdo-policy", "abdo-tools"],
      lockedPackages: 33,
      registryPackages: 23,
      sqlite: { rusqlite: "0.40.2", libsqlite3Sys: "0.38.2", bundled: true },
    })

    const extraMember = replaceSource(
      sources,
      "Cargo.toml",
      '  "bins/abdo-tool-worker",',
      '  "bins/abdo-tool-worker",\n  "crates/parallel-store",',
    )
    expect(() => assertS105CargoIdentity(extraMember)).toThrow("workspace identity drifted")

    for (const [before, after] of [
      ['default = []', 'default = ["test-hooks"]'],
      ['features = ["bundled", "hooks"]', 'features = ["bundled", "hooks", "modern_sqlite"]'],
      ['default-features = false', 'default-features = true'],
      ['sha2 = { version = "=0.11.0", default-features = false }', 'sha2 = { git = "https://example.invalid/sha2" }'],
      [
        '[dependencies]',
        '[dependencies]\nevidence-store = { path = "../abdo-evidence" }\nsecond-db = "1"',
      ],
    ]) {
      const changed = replaceSource(sources, "crates/abdo-journal/Cargo.toml", before!, after!)
      expect(() => assertS105CargoIdentity(changed)).toThrow("journal dependency, feature or target identity drifted")
    }

    const lockSource = sources.find((entry) => entry.path === "Cargo.lock")!.source
    expect(validateCargoLock(lockSource)).toMatchObject({ lockedPackages: 33, registryPackages: 23 })
    expect(() =>
      validateCargoLock(
        lockSource.replace(
          "23f2a97da3e3873c73cb2a2e71b35c40ff95e0b1eefa8d72d8499a6928c3b5b3",
          "0".repeat(64),
        ),
      ),
    ).toThrow("checksums")
    expect(() =>
      validateCargoLock(lockSource.replace("registry+https://github.com/rust-lang/crates.io-index", "git+https://example.invalid")),
    ).toThrow(/sources|external source/)
    expect(() => validateCargoLock(`${lockSource}\n[[package]]\nname = "second-db"\nversion = "1.0.0"\n`)).toThrow(
      "package versions",
    )
  })

  test("S105 journal rejects model, host, second-database and parallel-store capabilities", () => {
    expect(assertS105JournalCapabilities(sources)).toMatchObject({
      sqliteFiles: [
        "migrations/0001_initial.sql",
        "migrations/0002_effects.sql",
        "migrations/0003_leases_budgets.sql",
        "migrations/0004_compactions.sql",
      ],
      sqliteTables: [
        "journal_blobs",
        "journal_budgets",
        "journal_compactions",
        "journal_effects",
        "journal_events",
        "journal_leases",
        "journal_metadata",
        "journal_migrations",
        "journal_projections",
        "journal_snapshots",
        "journal_stream_heads",
      ],
      runtimeConnectionOpenSites: 1,
      modelCognitionMatches: 0,
      networkMatches: 0,
      parallelStoreMatches: 0,
    })

    const mutations = [
      { code: "\nstruct ModelPlanner;\n", message: "model or cognition" },
      { code: "\nfn net() { let _ = std::net::TcpStream::connect; }\n", message: "network" },
      { code: "\nfn env_read() { let _ = std::env::vars; }\n", message: "environment or process" },
      { code: "\nfn spawn() { let _ = std::process::Command::new; }\n", message: "environment or process" },
      { code: "\nunsafe fn unchecked() {}\n", message: "unsafe code" },
      { code: "\nstruct EvidenceStore;\n", message: "parallel evidence store" },
      { code: "\nfn second() { let _ = Connection::open_in_memory(); }\n", message: "exactly one SQLite" },
      {
        code: "\nuse rusqlite as sql;\nfn aliased() { let _ = sql::Connection::open_in_memory(); }\n",
        message: "aliases or wildcard-imports rusqlite",
      },
      {
        code: "\nuse rusqlite::Connection as قاعدة;\nfn unicode_alias() { let _ = قاعدة::open_in_memory(); }\n",
        message: "aliases or wildcard-imports rusqlite",
      },
      {
        code: "\ntype Db = Connection;\nfn type_alias() { let _ = Db::open_in_memory(); }\n",
        message: "aliases the SQLite connection type",
      },
      {
        code: "\nmacro_rules! indirect_open { ($db:path, $method:ident) => { $db::$method() }; }\n",
        message: "macro indirection",
      },
      { code: '\nconst ATTACH_SQL: &str = concat!("AT", "TACH secondary");\n', message: "macro indirection" },
      {
        code: "\nmacro_rules! indirect_include { ($reader:ident, $path:literal) => { $reader!($path) }; }\n",
        message: "macro indirection",
      },
      { code: '\nconst SECOND: &str = "ATTACH DATABASE secondary AS extra";\n', message: "second database" },
      {
        code: '\nfn escaped_attach(connection: &Connection) { let _ = connection.execute("AT\\x54ACH DATABASE ?1 AS hidden", ["second.sqlite"]); }\n',
        message: "second database",
      },
      {
        code: '\nfn escaped_schema(connection: &Connection) { let _ = connection.execute("CREATE\\x20TABLE hidden(id INTEGER)", []); }\n',
        message: "schema outside",
      },
      { code: '\nconst EXTRA: &[u8] = include_bytes!("outside.db");\n', message: "source inclusion" },
    ]
    for (const mutation of mutations) {
      const changed = appendSource(sources, "crates/abdo-journal/src/model.rs", mutation.code)
      expect(() => assertS105JournalCapabilities(changed)).toThrow(mutation.message)
    }

    const descriptiveEvidence = appendSource(
      sources,
      "crates/abdo-journal/src/model.rs",
      "\npub struct EvidenceIntegrityDescription;\n",
    )
    expect(() => assertS105JournalCapabilities(descriptiveEvidence)).not.toThrow()

    const cfgTestOnlySql = appendSource(
      sources,
      "crates/abdo-journal/src/model.rs",
      '\n#[cfg(test)]\nmod guard_probe {\n    use rusqlite::Connection;\n    fn schema_fixture() {\n        let _ = Connection::open_in_memory();\n        let _ = "CREATE TABLE test_only(value INTEGER)";\n    }\n}\n',
    )
    expect(() => assertS105JournalCapabilities(cfgTestOnlySql)).not.toThrow()

    for (const [path, before, after] of [
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        "const INJECTION_COUNT: usize = 10_000;",
        "const INJECTION_COUNT: usize = 100;",
      ],
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        "const LANE_COUNT: usize = 16;",
        "const LANE_COUNT: usize = 1;",
      ],
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        "const GLOBAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);",
        "const GLOBAL_TIMEOUT: Duration = Duration::from_secs(1);",
      ],
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        "const CRASH_PHASES: [CrashPhase; 10]",
        "const CRASH_PHASES: [CrashPhase; 9]",
      ],
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        'name: "checkpoint.after"',
        'name: "checkpoint.renamed"',
      ],
      [
        "crates/abdo-journal/tests/recovery_10k.rs",
        '#[ignore = "S105 exact 10,000 process-death/WAL recovery gate; not a power-loss claim"]',
        "// ignore removed",
      ],
      [
        "crates/abdo-journal/tests/restore_100k.rs",
        "const EVENT_COUNT: u64 = 100_000;",
        "const EVENT_COUNT: u64 = 10_000;",
      ],
      [
        "crates/abdo-journal/tests/restore_100k.rs",
        "const SNAPSHOT_SEQUENCE: u64 = 90_000;",
        "const SNAPSHOT_SEQUENCE: u64 = 9_000;",
      ],
      [
        "crates/abdo-journal/tests/restore_100k.rs",
        "const TAIL_COUNT: usize = 10_000;",
        "const TAIL_COUNT: usize = 1_000;",
      ],
      [
        "crates/abdo-journal/tests/restore_100k.rs",
        "const RESTORE_LIMIT: Duration = Duration::from_secs(2);",
        "const RESTORE_LIMIT: Duration = Duration::from_secs(20);",
      ],
      [
        "crates/abdo-journal/tests/restore_100k.rs",
        '#[ignore = "S105 100,000-event warm-filesystem-cache host benchmark; not a universal latency claim"]',
        "// ignore removed",
      ],
      [
        "crates/abdo-journal/tests/migration_atomicity.rs",
        '#[ignore = "S105 atomic migration process-death gate"]',
        "// ignore removed",
      ],
      [
        "crates/abdo-journal/tests/migration_atomicity.rs",
        '"migration.after_statement.1."',
        '"migration.after_statement.2."',
      ],
      [
        "crates/abdo-journal/tests/migration_atomicity.rs",
        "assert_migration_inventory_complete(&crash_points);",
        "// dynamic inventory assertion removed",
      ],
    ] as const) {
      const changed = replaceSource(sources, path, before, after)
      expect(() => assertS105JournalCapabilities(changed)).toThrow(/crash|restore|migration/)
    }

    const extraTable = appendSource(
      sources,
      "migrations/0001_initial.sql",
      "\nCREATE TABLE evidence_records (id INTEGER PRIMARY KEY) STRICT;\n",
    )
    expect(() => assertS105JournalCapabilities(extraTable)).toThrow("SQLite table identity drifted")
    const weakenedHeadForeignKey = replaceSource(
      sources,
      "migrations/0001_initial.sql",
      "FOREIGN KEY (stream_id, stream_sequence, global_sequence, event_hash)",
      "FOREIGN KEY (stream_id, stream_sequence, event_hash)",
    )
    expect(() => assertS105JournalCapabilities(weakenedHeadForeignKey)).toThrow("4-tuple head FK")
    const oversizedBlobSchema = replaceSource(
      sources,
      "migrations/0001_initial.sql",
      "size <= 16777216",
      "size <= 16777217",
    )
    expect(() => assertS105JournalCapabilities(oversizedBlobSchema)).toThrow("canonical schema")
    const weakenedPathIdentity = replaceSource(
      sources,
      "migrations/0001_initial.sql",
      "OR NEW.database_path_hash != OLD.database_path_hash",
      "OR 0",
    )
    expect(() => assertS105JournalCapabilities(weakenedPathIdentity)).toThrow("canonical schema")
    const changedSchemaDigest = replaceSource(
      sources,
      "crates/abdo-journal/src/migration.rs",
      "0xe6, 0x04, 0xe8, 0xb2",
      "0xe7, 0x04, 0xe8, 0xb2",
    )
    expect(() => assertS105JournalCapabilities(changedSchemaDigest)).toThrow("schema-manifest digest")
    const renamedSchemaObject = replaceSource(
      sources,
      "crates/abdo-journal/src/migration.rs",
      '("index", "journal_snapshots_latest", "journal_snapshots")',
      '("index", "journal_snapshots_unreviewed", "journal_snapshots")',
    )
    expect(() => assertS105JournalCapabilities(renamedSchemaObject)).toThrow("33-object schema manifest")
    const skippedOpenSchemaVerification = replaceSource(
      sources,
      "crates/abdo-journal/src/journal.rs",
      "journal.verify_on_open()?;",
      "// schema verification skipped",
    )
    expect(() => assertS105JournalCapabilities(skippedOpenSchemaVerification)).toThrow("verified exactly once")
    const weakenedAuthorizerProbe = replaceSource(
      sources,
      "crates/abdo-journal/tests/journal.rs",
      '"ATTACH DATABASE \':memory:\' AS escaped"',
      '"SELECT 1"',
    )
    expect(() => assertS105JournalCapabilities(weakenedAuthorizerProbe)).toThrow("test-hook SQL probe surface")
    const diskTempStore = replaceSource(
      sources,
      "crates/abdo-journal/src/journal.rs",
      '.pragma_update(None, "temp_store", "MEMORY")',
      '.pragma_update(None, "temp_store", "FILE")',
    )
    expect(() => assertS105JournalCapabilities(diskTempStore)).toThrow("temp_store=2")
    const prematureRecoveryEvidence = replaceSource(
      sources,
      "crates/abdo-journal/tests/migration_atomicity.rs",
      '    directory.remove();\n    println!(\n        "S105_MIGRATION_ATOMICITY points={} elapsed_ms={}",',
      '    println!(\n        "S105_MIGRATION_ATOMICITY points={} elapsed_ms={}",',
    )
    expect(() => assertS105JournalCapabilities(prematureRecoveryEvidence)).toThrow("success evidence must follow cleanup")
    expect(() =>
      assertS105JournalCapabilities([
        ...sources,
        { path: "migrations/0002_parallel.sql", source: "SELECT 1;" },
      ]),
    ).toThrow("exactly its declared canonical SQLite migrations")
    expect(() =>
      assertS105JournalCapabilities([
        ...sources,
        { path: "crates/abdo-journal/evidence-store/README.md", source: "parallel persistence" },
      ]),
    ).toThrow("parallel evidence-store path")

    for (const [path, before, after, message] of [
      [
        "crates/abdo-journal/src/identity.rs",
        'pub const PINNED_SQLITE_VERSION: &str = "3.53.2";',
        'pub const PINNED_SQLITE_VERSION: &str = "3.53.3";',
        "SQLite runtime identity",
      ],
      [
        "crates/abdo-journal/src/identity.rs",
        '    "THREADSAFE=1",',
        '    "THREADSAFE=2",',
        "REQUIRED_COMPILE_OPTIONS",
      ],
      [
        "crates/abdo-journal/src/identity.rs",
        "if normalized_compile_options\n            != PINNED_NORMALIZED_COMPILE_OPTIONS",
        "if !PINNED_NORMALIZED_COMPILE_OPTIONS.is_empty()\n            && normalized_compile_options != PINNED_NORMALIZED_COMPILE_OPTIONS",
        "SQLite runtime identity",
      ],
      [
        "crates/abdo-journal/tests/journal.rs",
        "assert_eq!(identity.source_id, PINNED_SQLITE_SOURCE_ID);",
        "assert!(!identity.source_id.is_empty());",
        "identity integration test",
      ],
    ] as const) {
      const changed = replaceSource(sources, path, before, after)
      expect(() => assertS105JournalCapabilities(changed)).toThrow(message)
    }

    const extraChildProcess = appendSource(
      sources,
      "crates/abdo-journal/src/bin/abdo-journal-test-child.rs",
      "\nfn extra_exit() { std::process::exit(1); }\n",
    )
    expect(() => assertS105JournalCapabilities(extraChildProcess)).toThrow("bounded exit site count drifted")

    const weakenedJournalRoot = replaceSource(
      sources,
      "crates/abdo-journal/tests/journal.rs",
      "#![forbid(unsafe_code)]",
      "#![deny(unsafe_code)]",
    )
    expect(() => assertS105JournalCapabilities(weakenedJournalRoot)).toThrow("crate-root forbid")
  }, 20_000)

  test("retired probe consumers are rejected without blocking the contract export", () => {
    const neutral = Array.from({ length: 250 }, (_, index) => ({
      path: `packages/neutral-${index}/src/index.ts`,
      source: 'import type { Command } from "@abdo/kernel/contracts"\nexport type Value = Command',
    }))
    expect(() => assertNoRetiredProbeConsumers(neutral)).not.toThrow()

    const oldClient = neutral.with(0, {
      path: "packages/consumer/src/index.ts",
      source: 'import { KernelBoundaryClient } from "@abdo/kernel"',
    })
    expect(() => assertNoRetiredProbeConsumers(oldClient)).toThrow("retired S101 probe")

    const oldBinary = neutral.with(0, {
      path: "packages/consumer/package.json",
      source: '{"scripts":{"probe":"abdo-kernel-probe"}}',
    })
    expect(() => assertNoRetiredProbeConsumers(oldBinary)).toThrow("retired S101 probe")

    for (const source of [
      'import { decode } from "../../kernel/src/protocol"',
      'export { value } from "#workspace/kernel/src/hash.js"',
      'const legacy = require("../../kernel/src/client")\nvoid legacy',
    ]) {
      const retiredModule = neutral.with(0, { path: "packages/consumer/src/index.ts", source })
      expect(() => assertNoRetiredProbeConsumers(retiredModule)).toThrow("retired S101 probe")
    }

    const aliasedRetiredModule = neutral
      .with(0, {
        path: "packages/consumer/tsconfig.json",
        source: JSON.stringify({ compilerOptions: { paths: { "@legacy/*": ["packages/kernel/src/*"] } } }),
      })
      .with(1, {
        path: "packages/consumer/src/aliased.ts",
        source: 'import { decode } from "@legacy/protocol"',
      })
    expect(() => assertNoRetiredProbeConsumers(aliasedRetiredModule)).toThrow("retired S101 probe")

    const inheritedAlias = neutral
      .with(0, {
        path: "tsconfig.base.json",
        source: JSON.stringify({ compilerOptions: { paths: { "@inherited/*": ["packages/kernel/src/*"] } } }),
      })
      .with(1, {
        path: "packages/consumer/tsconfig.json",
        source: JSON.stringify({ extends: "../../tsconfig.base.json" }),
      })
      .with(2, {
        path: "packages/consumer/src/inherited.ts",
        source: 'import { decode } from "@inherited/protocol"',
      })
    expect(() => assertNoRetiredProbeConsumers(inheritedAlias)).toThrow("retired S101 probe")
  })

  test("the Rust gate cannot inherit hostile Cargo, child-marker or credential state", () => {
    expect(RUST_TOOLCHAIN).toBe(`${RUST_VERSION}-${RUST_HOST}`)
    const toolchain = trustedRustToolchainIdentity()
    expect(toolchain.host).toBe(RUST_HOST)
    expect(cargoCommand("metadata", "--locked").slice(0, 5)).toEqual([
      toolchain.rustupExecutable,
      "run",
      RUST_TOOLCHAIN,
      "cargo",
      "metadata",
    ])
    const sanitized = sanitizedCargoEnvironment({
        PATH: "tools",
        SystemRoot: "windows",
        HOME: "home",
        RUSTUP_HOME: "forged-rustup-home",
        ABDO_ID_10M_CHILD_INDEX: "7",
        ABDO_ID_10M_CHILD_OUTPUT: "forged.bin",
        ABDO_ID_10M_CHILD_DIRECTORY: "forged-dir",
        ABDO_ID_10M_CHILD_TOKEN: "forged-token",
        ABDO_ID_10M_PARENT_GATE: "forged-parent",
        CARGO_HOME: "forged-cargo-home",
        CARGO_TARGET_DIR: "forged-target",
        CARGO_ENCODED_RUSTFLAGS: "forged-flags",
        ABDO_JOURNAL_CRASH_10K_PARENT_GATE: "forged-crash-parent",
        ABDO_JOURNAL_MIGRATION_PARENT_GATE: "forged-migration-parent",
        ABDO_JOURNAL_RESTORE_100K_PARENT_GATE: "forged-restore-parent",
        CC: "gcc",
        CXX: "g++",
        INCLUDE: "ambient-include",
        LIB: "ambient-lib",
        CARGO_BUILD_TARGET: "x86_64-pc-windows-gnu",
        API_TOKEN: "secret-token",
        PASSWORD: "secret-password",
        RUSTFLAGS: "--cfg bypass",
      })
    expect(sanitized).toEqual({
      CARGO_NET_OFFLINE: "true",
      PATH: "tools",
      SystemRoot: "windows",
      HOME: "home",
      RUSTUP_HOME: toolchain.rustupHome,
    })
    expect(sanitized.RUSTUP_HOME).not.toBe("forged-rustup-home")

    const rustcIdentity = [
      RUSTC_VERSION_IDENTITY,
      "binary: rustc",
      `commit-hash: e408947bf${"0".repeat(31)}`,
      "commit-date: 2026-03-25",
      `host: ${RUST_HOST}`,
      `release: ${RUST_VERSION}`,
      "LLVM version: 21.1.2",
    ].join("\n")
    expect(validateRustToolchainPreflight(rustcIdentity, CARGO_VERSION_IDENTITY)).toEqual({
      rustc: RUSTC_VERSION_IDENTITY,
      cargo: CARGO_VERSION_IDENTITY,
      host: RUST_HOST,
    })
    for (const [rustc, cargo] of [
      [rustcIdentity.replace(`host: ${RUST_HOST}`, "host: fake-host"), CARGO_VERSION_IDENTITY],
      [rustcIdentity.replace(`release: ${RUST_VERSION}`, "release: 1.94.0"), CARGO_VERSION_IDENTITY],
      [rustcIdentity.replace(RUSTC_VERSION_IDENTITY, "rustc 1.94.1 (forged 2026-03-25)"), CARGO_VERSION_IDENTITY],
      [rustcIdentity, "cargo 1.94.1 (forged 2026-03-24)"],
    ] as const) {
      expect(() => validateRustToolchainPreflight(rustc, cargo)).toThrow(/rustc|Cargo/)
    }
    expect(() => assertNoCargoConfigurationPaths([])).not.toThrow()
    expect(() => assertNoCargoConfigurationPaths(["packages/consumer/.cargo/config.toml"])).toThrow(
      "can inject the S104 gate",
    )
  })

  test("prepared Cargo contexts reject spoofed objects, marker drift and escaping paths", () => {
    const root = join("C:\\", "Temp", "abdo-cargo-fixture")
    const context = {
      root,
      cwd: join(root, "work"),
      cargoHome: join(root, "cargo-home"),
      targetDirectory: join(root, "target"),
      markerPath: join(root, "prepared-context.json"),
    }
    const token = "a".repeat(64)
    const digest = "b".repeat(64)
    const marker = {
      version: 1,
      token,
      ownerPid: 42,
      ...context,
      cargoLockSha256: digest,
      fetchCount: 1,
      networkState: "offline",
    } as const
    expect(validatePreparedCargoDescriptor(context, marker, token, digest, [42])).toEqual(marker)

    expect(() =>
      assertPreparedCargoContext({ ...context, environment: {} } as PreparedCargoContext),
    ).toThrow("not issued")
    expect(() => validatePreparedCargoDescriptor(context, { ...marker, token: "c".repeat(64) }, token, digest, [42])).toThrow(
      "token mismatch",
    )
    expect(() => validatePreparedCargoDescriptor(context, { ...marker, fetchCount: 0 }, token, digest, [42])).toThrow(
      "marker identity drifted",
    )

    const escaped = { ...context, cargoHome: join(root, "..", "shared-cargo-home") }
    expect(() =>
      validatePreparedCargoDescriptor(
        escaped,
        { ...marker, cargoHome: escaped.cargoHome },
        token,
        digest,
        [42],
      ),
    ).toThrow("escapes its root")
  })

  test("CI parses and pins every S104 integration gate without path-filter bypasses", () => {
    expect(assertKernelBoundaryWorkflow(workflowSource)).toMatchObject({
      job: "kernel-boundaries",
      pinnedActions: 2,
    })
    expect(() =>
      assertKernelBoundaryWorkflow(workflowSource.replace("  push:\n", '  push: { paths: ["packages/kernel/**"] }\n')),
    ).toThrow("must not use path filters")
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@main"),
      ),
    ).toThrow("not pinned to a full commit SHA")
    expect(() => assertKernelBoundaryWorkflow(workflowSource.replace("kernel-boundaries:", "s104-boundaries:"))).toThrow(
      "job allowlist drifted",
    )
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace("bun run typecheck", "bun run test:unrelated"),
      ),
    ).toThrow("run blocks drifted")
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace(
          "      - name: Verify product composition",
          "      - name: Verify product composition\n        if: false",
        ),
      ),
    ).toThrow("may not define if")
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace(
          "        run: bun run structure",
          "        run: |\n          exit 0\n          bun run structure",
        ),
      ),
    ).toThrow("run blocks drifted")
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace("permissions:\n", "defaults:\n  run:\n    shell: bash {0} || true\n\npermissions:\n"),
      ),
    ).toThrow("top-level keys drifted")
    expect(() => assertKernelBoundaryWorkflow(workflowSource.replace("timeout-minutes: 90", "timeout-minutes: 1"))).toThrow(
      "timeout drifted",
    )
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace(
          "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
          "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n      - uses: actions/cache@0123456789012345678901234567890123456789",
        ),
      ),
    ).toThrow("step count drifted")
    expect(() =>
      assertKernelBoundaryWorkflow(
        workflowSource.replace(
          "bun test --timeout 120000 packages/kernel",
          "cargo fetch --locked\n          bun test --timeout 120000 packages/kernel",
        ),
      ),
    ).toThrow("run blocks drifted")
  })
})

const KERNEL_PACKAGE_DIR = join(import.meta.dir, "..")

async function loadSources(): Promise<BoundarySource[]> {
  const paths = await listBoundarySourceFiles()
  return Promise.all(paths.map(async (path) => ({
    path,
    source: (await Bun.file(join(KERNEL_PACKAGE_DIR, path)).text()).replaceAll("\r\n", "\n"),
  })))
}

function appendSource(values: readonly BoundarySource[], path: string, code: string) {
  return values.map((entry) => (entry.path === path ? { ...entry, source: `${entry.source}${code}` } : entry))
}

function replaceSource(values: readonly BoundarySource[], path: string, before: string, after: string) {
  return values.map((entry) => {
    if (entry.path !== path) return entry
    if (!entry.source.includes(before)) throw new Error(`fixture source did not contain ${before}`)
    return { ...entry, source: entry.source.replace(before, after) }
  })
}

function gateOutput(testName: string, evidence: string, elapsed: string) {
  return [
    "running 1 test",
    `test ${testName} ... ${evidence}`,
    "ok",
    "",
    `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in ${elapsed}`,
  ].join("\n")
}

interface CargoMetadataFixtureDependency {
  name: string
  source: string | null
  req: string
  kind: string | null
  rename: string | null
  optional: boolean
  uses_default_features: boolean
  features: string[]
  path: string | null
}

interface CargoMetadataFixtureTarget {
  name: string
  src_path: string
  kind: string[]
  "required-features": string[]
  test: boolean
  doctest: boolean
}

interface CargoMetadataFixturePackage {
  id: string
  name: string
  version: string
  source: string | null
  checksum: string | null
  edition: string
  manifest_path: string
  dependencies: CargoMetadataFixtureDependency[]
  features: Record<string, string[]>
  targets: CargoMetadataFixtureTarget[]
}

interface CargoMetadataFixtureNode {
  id: string
  dependencies: string[]
  deps: { name: string; pkg: string; dep_kinds: unknown[] }[]
  features: string[]
}

interface CargoMetadataFixture {
  packages: CargoMetadataFixturePackage[]
  workspace_members: string[]
  workspace_default_members: string[]
  resolve: {
    root: string | null
    nodes: CargoMetadataFixtureNode[]
  }
}

function cargoMetadataFixture(): CargoMetadataFixture {
  const actual = Bun.spawnSync(
    ["cargo", "metadata", "--locked", "--offline", "--format-version", "1"],
    { cwd: KERNEL_PACKAGE_DIR, env: { ...process.env, CARGO_TERM_COLOR: "never" } },
  )
  if (actual.exitCode !== 0) {
    throw new Error(`cargo metadata fixture failed: ${actual.stderr.toString()}`)
  }
  return JSON.parse(actual.stdout.toString()) as CargoMetadataFixture

  // Historical fixture construction is intentionally unreachable. Keeping it
  // below for this migration makes the diff reviewable while every mutation
  // test above now starts from Cargo's current locked graph.
  const lockSource = sources.find((entry) => entry.path === "Cargo.lock")?.source
  if (!lockSource) throw new Error("Cargo.lock fixture source is missing")
  const lock = Bun.TOML.parse(lockSource!) as {
    package: {
      name: string
      version: string
      source?: string
      checksum?: string
      dependencies?: string[]
    }[]
  }
  const locked = lock.package
  const idByName = new Map(
    locked.map((entry) => [
      entry.name,
      entry.source
        ? `${entry.source}#${entry.name}@${entry.version}`
        : `path+file:///kernel/crates/${entry.name}#${entry.name}@${entry.version}`,
    ]),
  )

  const dependency = (
    name: string,
    source: string | null,
    req: string,
    usesDefaultFeatures: boolean,
    features: string[],
    path: string | null,
  ): CargoMetadataFixtureDependency => ({
    name,
    source,
    req,
    kind: null,
    rename: null,
    optional: false,
    uses_default_features: usesDefaultFeatures,
    features,
    path,
  })
  const target = (
    name: string,
    sourcePath: string,
    kind: string,
    test: boolean,
    doctest: boolean,
    requiredFeatures: string[] = [],
  ): CargoMetadataFixtureTarget => ({
    name,
    src_path: join(KERNEL_PACKAGE_DIR, ...sourcePath.split("/")),
    kind: [kind],
    "required-features": requiredFeatures,
    test,
    doctest,
  })
  const registrySource = "registry+https://github.com/rust-lang/crates.io-index"
  const packages: CargoMetadataFixturePackage[] = locked.map((entry) => {
    const base: CargoMetadataFixturePackage = {
      id: idByName.get(entry.name)!,
      name: entry.name,
      version: entry.version,
      source: entry.source ?? null,
      checksum: entry.checksum ?? null,
      edition: "2021",
      manifest_path: join(KERNEL_PACKAGE_DIR, "fixture-registry", entry.name, "Cargo.toml"),
      dependencies: [],
      features: {},
      targets: [],
    }
    if (entry.name === "abdo-contracts") {
      return {
        ...base,
        manifest_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts", "Cargo.toml"),
        targets: [
          target(
            "abdo-contracts-codegen",
            "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
            "bin",
            true,
            false,
          ),
          target("abdo-effects-worker", "crates/abdo-contracts/src/bin/abdo-effects-worker.rs", "bin", true, false),
          target("abdo_contracts", "crates/abdo-contracts/src/lib.rs", "lib", true, true),
          target("codegen", "crates/abdo-contracts/tests/codegen.rs", "test", true, false),
          target("golden", "crates/abdo-contracts/tests/golden.rs", "test", true, false),
          target("id_10m", "crates/abdo-contracts/tests/id_10m.rs", "test", true, false),
          target("strict_mutations", "crates/abdo-contracts/tests/strict_mutations.rs", "test", true, false),
          target("worker_gate", "crates/abdo-contracts/tests/worker_gate.rs", "test", true, false),
        ],
      }
    }
    if (entry.name === "abdo-authority") {
      return {
        ...base,
        manifest_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-authority", "Cargo.toml"),
        dependencies: [
          dependency(
            "abdo-contracts",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts"),
          ),
          dependency("hmac", registrySource, "=0.13.0", false, [], null),
          dependency("sha2", registrySource, "=0.11.0", false, [], null),
        ],
        features: {},
        targets: [
          target("abdo_authority", "crates/abdo-authority/src/lib.rs", "lib", true, true),
          target("authority", "crates/abdo-authority/tests/authority.rs", "test", true, false),
          target("authority_sweep", "crates/abdo-authority/tests/authority_sweep.rs", "test", true, false),
          target("policy", "crates/abdo-authority/tests/policy.rs", "test", true, false),
        ],
      }
    }
    if (entry.name === "abdo-runtime") {
      return {
        ...base,
        manifest_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-runtime", "Cargo.toml"),
        dependencies: [
          dependency(
            "abdo-authority",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-authority"),
          ),
          dependency(
            "abdo-contracts",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts"),
          ),
          dependency(
            "abdo-journal",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-journal"),
          ),
          dependency(
            "abdo-kernel",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-kernel"),
          ),
        ],
        features: { default: [], "effectful-dispatch": [], "test-hooks": ["abdo-journal/test-hooks"] },
        targets: [
          target("abdo_runtime", "crates/abdo-runtime/src/lib.rs", "lib", true, true),
          target("budget", "crates/abdo-runtime/tests/budget.rs", "test", true, false),
          target("budget_fencing", "crates/abdo-runtime/tests/budget_fencing.rs", "test", true, false),
          target("control", "crates/abdo-runtime/tests/control.rs", "test", true, false),
          target("control_throughput", "crates/abdo-runtime/tests/control_throughput.rs", "test", true, false),
          target("crash_boundaries", "crates/abdo-runtime/tests/crash_boundaries.rs", "test", true, false),
          target("no_blind_retry", "crates/abdo-runtime/tests/no_blind_retry.rs", "test", true, false),
          target("reconcile", "crates/abdo-runtime/tests/reconcile.rs", "test", true, false),
          target("reconcile_sweep", "crates/abdo-runtime/tests/reconcile_sweep.rs", "test", true, false),
          target("session", "crates/abdo-runtime/tests/session.rs", "test", true, false),
          target("schedule", "crates/abdo-runtime/tests/schedule.rs", "test", true, false),
          target("schedule_100k", "crates/abdo-runtime/tests/schedule_100k.rs", "test", true, false),
          target("session_steps", "crates/abdo-runtime/tests/session_steps.rs", "test", true, false),
          target("supervisor", "crates/abdo-runtime/tests/supervisor.rs", "test", true, false),
        ],
      }
    }
    if (entry.name === "abdo-kernel") {
      return {
        ...base,
        manifest_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-kernel", "Cargo.toml"),
        dependencies: [
          dependency(
            "abdo-contracts",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts"),
          ),
          dependency("sha2", registrySource, "=0.11.0", false, [], null),
        ],
        features: {},
        targets: [
          target("abdo_kernel", "crates/abdo-kernel/src/lib.rs", "lib", true, true),
          target("determinism_1k", "crates/abdo-kernel/tests/determinism_1k.rs", "test", true, false),
          target("reduce", "crates/abdo-kernel/tests/reduce.rs", "test", true, false),
          target("transitions_1m", "crates/abdo-kernel/tests/transitions_1m.rs", "test", true, false),
        ],
      }
    }
    if (entry.name === "abdo-journal") {
      return {
        ...base,
        manifest_path: join(KERNEL_PACKAGE_DIR, "crates", "abdo-journal", "Cargo.toml"),
        dependencies: [
          dependency(
            "abdo-contracts",
            null,
            "*",
            true,
            [],
            join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts"),
          ),
          dependency("rusqlite", registrySource, "=0.40.2", false, ["bundled", "hooks"], null),
          dependency("sha2", registrySource, "=0.11.0", false, [], null),
        ],
        features: { default: [], "test-hooks": [] },
        targets: [
          target(
            "abdo-journal-test-child",
            "crates/abdo-journal/src/bin/abdo-journal-test-child.rs",
            "bin",
            false,
            false,
            ["test-hooks"],
          ),
          target("abdo_journal", "crates/abdo-journal/src/lib.rs", "lib", true, true),
          target("compaction", "crates/abdo-journal/tests/compaction.rs", "test", true, false),
          target("journal", "crates/abdo-journal/tests/journal.rs", "test", true, false),
          target("migration_atomicity", "crates/abdo-journal/tests/migration_atomicity.rs", "test", true, false),
          target("recovery_10k", "crates/abdo-journal/tests/recovery_10k.rs", "test", true, false),
          target("recovery_integrity", "crates/abdo-journal/tests/recovery_integrity.rs", "test", true, false),
          target("restore_100k", "crates/abdo-journal/tests/restore_100k.rs", "test", true, false),
        ],
      }
    }
    return base
  })

  const selectedFeatures: Record<string, string[]> = {
    "abdo-authority": [],
    "abdo-contracts": [],
    "abdo-journal": ["default"],
    "abdo-kernel": [],
    "abdo-runtime": ["default"],
    bitflags: [],
    cmov: [],
    ctutils: [],
    hmac: [],
    "block-buffer": [],
    cc: [],
    "cfg-if": [],
    cpufeatures: [],
    "crypto-common": [],
    digest: ["block-api", "default", "mac"],
    "fallible-iterator": ["alloc", "default"],
    "fallible-streaming-iterator": [],
    "find-msvc-tools": [],
    "hybrid-array": [],
    libc: [],
    "libsqlite3-sys": [
      "bundled",
      "bundled_bindings",
      "cc",
      "default",
      "min_sqlite_version_3_34_1",
      "pkg-config",
      "vcpkg",
    ],
    "pkg-config": [],
    rusqlite: ["bundled", "hooks", "modern_sqlite"],
    sha2: [],
    shlex: ["default", "std"],
    smallvec: [],
    typenum: ["const-generics"],
    vcpkg: [],
  }
  const nodes: CargoMetadataFixtureNode[] = locked.map((entry) => {
    const dependencyNames = entry.dependencies ?? []
    return {
      id: idByName.get(entry.name)!,
      dependencies: dependencyNames.map((name) => idByName.get(name)!),
      deps: dependencyNames.map((name) => ({
        name: entry.name === "digest" && name === "crypto-common" ? "common" : name.replaceAll("-", "_"),
        pkg: idByName.get(name)!,
        dep_kinds: [
          {
            kind:
              entry.name === "libsqlite3-sys" && ["cc", "pkg-config", "vcpkg"].includes(name) ? "build" : null,
            target: null,
          },
        ],
      })),
      features: selectedFeatures[entry.name]!,
    }
  })
  const contractsId = idByName.get("abdo-contracts")!
  const journalId = idByName.get("abdo-journal")!
  const kernelCoreId = idByName.get("abdo-kernel")!
  const runtimeId = idByName.get("abdo-runtime")!
  const authorityId = idByName.get("abdo-authority")!
  return {
    packages,
    workspace_members: [contractsId, journalId, kernelCoreId, runtimeId, authorityId],
    workspace_default_members: [contractsId, journalId, kernelCoreId, runtimeId, authorityId],
    resolve: { root: null as string | null, nodes },
  }
}
