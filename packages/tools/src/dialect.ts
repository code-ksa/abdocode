/**
 * CL-16A3 — the execution DIALECT, and the facts that decide whether it can be
 * isolated on this machine.
 *
 * WHY A DIALECT EXISTS AT ALL
 *
 * CL-16A2-E ended by measuring that "can this platform deny the network?" and
 * "can this platform RUN this?" are different questions. A zero-capability
 * AppContainer denies the network perfectly and cannot start msys2 bash at all.
 * A single `supported` flag hid that, and one boolean would hide the next such
 * difference too.
 *
 * A dialect names the LANGUAGE AND LAUNCH SHAPE of an execution. It is derived
 * HOST-SIDE from the tool contract and the normalizer; the model never sends
 * one, and no tool input carries one. Nothing here translates between dialects:
 * a command written for bash stays a command written for bash, and if its
 * dialect cannot be isolated the run is REFUSED rather than quietly handed to a
 * different interpreter with different quoting, expansion and exit semantics.
 *
 * THE NESTED-SHELL RULE, and how it was corrected in CL-16A3-B: `cmd /c bash -c
 * ...` is not a cmd execution that happens to mention bash — what ultimately
 * runs IS bash, so classifying by the outer executable alone would let an
 * unsupported dialect be smuggled through a supported one.
 *
 * The FIRST version of this rule flagged any argv token whose leaf name was a
 * shell. That refused far too much: an argument whose value is "bash", a file
 * called `bash.txt`, `cmd /c echo bash`, and any JSON payload mentioning bash.
 * Refusing safe work is not fail-closed, it is wrong. The rule now lives in
 * `effective-runtime.ts` and reads each launch shape by its own grammar; see
 * that module for the limits it declares rather than hides.
 */

export type { ExecutionDialect } from "./effective-runtime"
export { deriveEffectiveRuntime, isAbsoluteWindowsPath, isShellLeaf, leafOf, powershellScriptInvokesShell, tokenizeCmdPayload } from "./effective-runtime"

import { deriveEffectiveRuntime, type ExecutionDialect } from "./effective-runtime"

export interface DialectDerivation {
  readonly dialect: ExecutionDialect
  /** True when the EFFECTIVE runtime differs from the named executable. */
  readonly nestedShell: boolean
  readonly effectiveExecutable?: string
  readonly reasonCodes: readonly string[]
}

/**
 * Derive the dialect from an already-separated executable and argv.
 *
 * Delegates to `deriveEffectiveRuntime`, which reads each launch shape by its
 * own grammar instead of scanning argv for a word. See that module for why the
 * previous token-matching rule was replaced.
 */
export function deriveExecutionDialect(executable: string, argv: readonly string[]): DialectDerivation {
  const rt = deriveEffectiveRuntime(executable, argv)
  const nestedShell = rt.dialect === "bash" && rt.effectiveExecutable !== undefined && rt.effectiveExecutable !== executable
  return {
    dialect: rt.dialect,
    nestedShell,
    ...(rt.effectiveExecutable ? { effectiveExecutable: rt.effectiveExecutable } : {}),
    reasonCodes: rt.reasonCodes,
  }
}

// ─────────────────────────────────────────────────── §9 capability FACTS

/**
 * Separate facts, not one boolean.
 *
 * Each is `true` only when it was MEASURED true. `false` means measured false;
 * `undefined` means unknown — and unknown is refused, never assumed. An allow
 * requires every fact ON THE SPECIFIC PATH to be true, so a new question can be
 * added later without silently widening an existing allow.
 */
export interface WindowsExecutionFacts {
  /** The AppContainer mechanism itself: profile + job + zero capabilities. */
  readonly appContainerPrimitiveSupported?: boolean
  readonly directExecutionSupported?: boolean
  readonly powershellDialectSupported?: boolean
  readonly cmdDialectSupported?: boolean
  /** Measured FALSE on this machine: msys2 bash exits 0xC0000142 in a container. */
  readonly bashDialectSupported?: boolean
  readonly executableAccessible?: boolean
  readonly cwdAccessible?: boolean
  readonly scopeGrantSafe?: boolean
  readonly runtimeDependenciesAccessible?: boolean
  readonly hostIntegritySupported?: boolean
}

/** The facts a given dialect depends on. Named, so the refusal can say which. */
export const FACTS_REQUIRED_FOR: Record<Exclude<ExecutionDialect, "unknown">, readonly (keyof WindowsExecutionFacts)[]> = {
  direct: ["appContainerPrimitiveSupported", "hostIntegritySupported", "directExecutionSupported", "executableAccessible", "runtimeDependenciesAccessible", "cwdAccessible", "scopeGrantSafe"],
  powershell: ["appContainerPrimitiveSupported", "hostIntegritySupported", "powershellDialectSupported", "executableAccessible", "runtimeDependenciesAccessible", "cwdAccessible", "scopeGrantSafe"],
  cmd: ["appContainerPrimitiveSupported", "hostIntegritySupported", "cmdDialectSupported", "executableAccessible", "runtimeDependenciesAccessible", "cwdAccessible", "scopeGrantSafe"],
  bash: ["appContainerPrimitiveSupported", "hostIntegritySupported", "bashDialectSupported", "executableAccessible", "runtimeDependenciesAccessible", "cwdAccessible", "scopeGrantSafe"],
}

export interface DialectVerdict {
  readonly allowed: boolean
  readonly reasonCode?: string
  readonly detail?: string
  /** Facts that were false or unknown. Empty when allowed. */
  readonly missing: readonly (keyof WindowsExecutionFacts)[]
}

/**
 * May this dialect be isolated here?
 *
 * Fail-closed in three separate ways, each of which has already been a real
 * failure mode somewhere in this line of work: `unknown` is refused outright, a
 * missing fact is refused (rather than defaulted), and bash carries its own
 * explicit reason code so the refusal is legible instead of being a generic
 * "unsupported".
 */
export function evaluateDialect(dialect: ExecutionDialect, facts: WindowsExecutionFacts): DialectVerdict {
  if (dialect === "unknown") {
    return { allowed: false, reasonCode: "windows_execution_dialect_unknown", detail: "the execution shape could not be characterised, so it cannot be isolated", missing: [] }
  }
  const required = FACTS_REQUIRED_FOR[dialect]
  const missing = required.filter((k) => facts[k] !== true)
  if (missing.length === 0) return { allowed: true, missing: [] }

  if (dialect === "bash" && facts.bashDialectSupported !== true) {
    return {
      allowed: false,
      reasonCode: "windows_appcontainer_shell_runtime_unsupported",
      detail: "a generic POSIX shell cannot run inside a zero-capability AppContainer on this platform; nothing was executed",
      missing,
    }
  }
  const scopeFacts: (keyof WindowsExecutionFacts)[] = ["executableAccessible", "cwdAccessible", "scopeGrantSafe", "runtimeDependenciesAccessible"]
  if (missing.every((m) => scopeFacts.includes(m))) {
    return {
      allowed: false,
      reasonCode: "windows_appcontainer_filesystem_scope_unsupported",
      detail: `the execution cannot be scoped safely: ${missing.join(", ")} not proven. Nothing was executed and no container was created.`,
      missing,
    }
  }
  return {
    allowed: false,
    reasonCode: "windows_execution_dialect_unsupported",
    detail: `dialect ${dialect} is not supported here: ${missing.join(", ")} not proven`,
    missing,
  }
}
