/**
 * CL-16A3 §2/§9/§11 — the dialect contract, the capability facts, and the
 * bypass-prevention rules.
 *
 * The rule the whole file exists to defend: an unsupported execution shape must
 * not become supported by being wrapped in a supported one. `cmd /c bash -c ...`
 * really runs bash, and a classifier that looked only at the outer executable
 * would hand it a container it cannot survive — or, worse, report it as isolated.
 */
import { describe, expect, test } from "bun:test"
import {
  deriveExecutionDialect,
  evaluateDialect,
  FACTS_REQUIRED_FOR,
  leafOf,
  type WindowsExecutionFacts,
} from "../src/dialect"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
const NODE = "C:\\Program Files\\nodejs\\node.exe"

/** Everything measured true — the only shape that may be allowed. */
const ALL_TRUE: WindowsExecutionFacts = {
  appContainerPrimitiveSupported: true,
  directExecutionSupported: true,
  powershellDialectSupported: true,
  cmdDialectSupported: true,
  bashDialectSupported: true,
  executableAccessible: true,
  cwdAccessible: true,
  scopeGrantSafe: true,
  runtimeDependenciesAccessible: true,
  hostIntegritySupported: true,
}

/** What this machine actually measured in CL-16A2-E. */
const MEASURED: WindowsExecutionFacts = { ...ALL_TRUE, bashDialectSupported: false }

describe("CL-16A3 section 2 - the dialect is derived, never declared", () => {
  test("each launch shape is recognised", () => {
    expect(deriveExecutionDialect(CMD, ["/c", "echo", "hi"]).dialect).toBe("cmd")
    expect(deriveExecutionDialect(PS, ["-NoProfile", "-Command", "Write-Output hi"]).dialect).toBe("powershell")
    expect(deriveExecutionDialect(BASH, ["-c", "echo hi"]).dialect).toBe("bash")
    expect(deriveExecutionDialect(NODE, ["-e", "console.log(1)"]).dialect).toBe("direct")
    expect(deriveExecutionDialect("/usr/bin/env", ["true"]).dialect).toBe("direct")
  })

  test("a bare, PATH-resolved name is UNKNOWN, not direct", () => {
    // PATH is precisely what a run can influence, so a name resolved through it
    // is not a program this layer can make a statement about.
    for (const bare of ["node", "python", "some-tool.exe"]) {
      const d = deriveExecutionDialect(bare, [])
      expect(d.dialect).toBe("unknown")
      expect(d.reasonCodes).toContain("executable_not_absolute")
    }
  })

  test("an executable NAMED bash is never classified direct", () => {
    for (const b of ["bash", "bash.exe", BASH, "/bin/sh", "zsh"]) {
      expect(deriveExecutionDialect(b, ["-c", "echo x"]).dialect).toBe("bash")
    }
  })

  test("NESTED SHELL: cmd /c bash is classified as BASH, not as cmd", () => {
    // The bypass this prevents: smuggling an unsupported dialect through a
    // supported one. What actually runs is bash, and CL-16A3-B made the answer
    // precise - `bash` rather than a vague `unknown` - so the refusal can carry
    // the specific shell-runtime reason code.
    const d = deriveExecutionDialect(CMD, ["/c", "bash", "-c", "echo pwned"])
    expect(d.dialect).toBe("bash")
    expect(d.nestedShell).toBe(true)
    expect(d.effectiveExecutable).toBe("bash")
    // ...and on THIS machine bash is measured unsupported, so it is refused.
    const v = evaluateDialect(d.dialect, MEASURED)
    expect(v.allowed).toBe(false)
    expect(v.reasonCode).toBe("windows_appcontainer_shell_runtime_unsupported")
  })

  test("NESTED SHELL: powershell -Command bash does not grant bash support", () => {
    const d = deriveExecutionDialect(PS, ["-NoProfile", "-Command", "bash -c 'echo pwned'"])
    // CL-16A3-B makes this precise: the conservative script scan sees `bash` in
    // COMMAND POSITION (it opens the script), so the shape cannot be
    // characterised and the answer is `unknown` - which is refused. It is not
    // claimed to be a full PowerShell parse; over-refusing here is the accepted
    // cost of not having one.
    expect(d.dialect).toBe("unknown")
    expect(evaluateDialect(d.dialect, ALL_TRUE).allowed).toBe(false)
    // And bash itself is never granted on this machine, by any route.
    const asBash = evaluateDialect("bash", MEASURED)
    expect(asBash.allowed).toBe(false)
    expect(asBash.reasonCode).toBe("windows_appcontainer_shell_runtime_unsupported")
  })

  test("a shell path is only a runtime where the GRAMMAR executes it", () => {
    // The correction CL-16A3-B made. A shell mentioned where the launch shape
    // does not execute it is just an argument:
    expect(deriveExecutionDialect(NODE, ["--", "/bin/sh", "-c", "echo x"]).dialect).toBe("direct")
    // ...but where cmd really does execute the payload, it is the runtime:
    expect(deriveExecutionDialect(CMD, ["/c", "/bin/sh", "-c", "echo x"]).dialect).toBe("bash")
  })

  test("leafOf handles both separators and is case-insensitive", () => {
    expect(leafOf("C:\\Windows\\System32\\CMD.EXE")).toBe("cmd.exe")
    expect(leafOf("/usr/bin/bash")).toBe("bash")
  })
})

describe("CL-16A3 section 9 - separate facts, and unknown is refused", () => {
  test("every fact true allows the dialect", () => {
    for (const d of ["direct", "powershell", "cmd", "bash"] as const) {
      expect(evaluateDialect(d, ALL_TRUE).allowed).toBe(true)
    }
  })

  test("EVERY required fact in turn: one missing refuses", () => {
    // A verdict that only checked the dialect flag would pass the row above and
    // still allow a run whose cwd is unreachable.
    for (const d of ["direct", "powershell", "cmd"] as const) {
      for (const fact of FACTS_REQUIRED_FOR[d]) {
        const v = evaluateDialect(d, { ...ALL_TRUE, [fact]: false })
        expect(v.allowed).toBe(false)
        expect(v.missing).toContain(fact)
      }
    }
  })

  test("UNKNOWN (absent) is refused exactly like false", () => {
    // The fail-closed rule: a fact nobody measured is not a fact.
    const { cwdAccessible, ...withoutCwd } = ALL_TRUE
    void cwdAccessible
    const v = evaluateDialect("direct", withoutCwd)
    expect(v.allowed).toBe(false)
    expect(v.missing).toContain("cwdAccessible")
  })

  test("empty facts refuse every dialect", () => {
    for (const d of ["direct", "powershell", "cmd", "bash"] as const) {
      expect(evaluateDialect(d, {}).allowed).toBe(false)
    }
  })

  test("bash carries its OWN reason code, not a generic unsupported", () => {
    const v = evaluateDialect("bash", MEASURED)
    expect(v.allowed).toBe(false)
    expect(v.reasonCode).toBe("windows_appcontainer_shell_runtime_unsupported")
  })

  test("a scope-only failure is reported as a SCOPE problem", () => {
    // Distinguishing this from "the dialect is unsupported" is the whole point
    // of CL-16A2-E's correction: PowerShell works, an unreachable cwd does not.
    for (const fact of ["executableAccessible", "cwdAccessible", "scopeGrantSafe", "runtimeDependenciesAccessible"] as const) {
      const v = evaluateDialect("powershell", { ...ALL_TRUE, [fact]: false })
      expect(v.reasonCode).toBe("windows_appcontainer_filesystem_scope_unsupported")
      expect(v.detail).toContain("Nothing was executed")
    }
  })

  test("the MEASURED facts of this machine: native yes, bash no", () => {
    expect(evaluateDialect("cmd", MEASURED).allowed).toBe(true)
    expect(evaluateDialect("powershell", MEASURED).allowed).toBe(true)
    expect(evaluateDialect("direct", MEASURED).allowed).toBe(true)
    expect(evaluateDialect("bash", MEASURED).allowed).toBe(false)
  })
})

describe("CL-16A3 section 11 - the dialect cannot be chosen from outside", () => {
  test("derivation depends ONLY on executable and argv", () => {
    // No environment, no ambient state: the same inputs give the same dialect
    // whatever the process environment says.
    const before = deriveExecutionDialect(CMD, ["/c", "echo", "x"]).dialect
    process.env.ABDO_EXECUTION_DIALECT = "direct"
    process.env.EXECUTION_DIALECT = "bash"
    try {
      expect(deriveExecutionDialect(CMD, ["/c", "echo", "x"]).dialect).toBe(before)
    } finally {
      delete process.env.ABDO_EXECUTION_DIALECT
      delete process.env.EXECUTION_DIALECT
    }
  })

  test("the dialect module reads no environment and no argv of its own", () => {
    const src = require("node:fs").readFileSync(new URL("../src/dialect.ts", import.meta.url), "utf8") as string
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "")
    expect(code).not.toContain("process.env")
    expect(code).not.toContain("process.argv")
  })

  test("a command STRING cannot be classified at all - only separated argv", () => {
    // `deriveExecutionDialect` takes an executable and an argv array. Passing a
    // whole command line as the executable yields `unknown`, because a string
    // whose interpretation is in question cannot answer the question.
    expect(deriveExecutionDialect("echo hi && bash -c 'x'", []).dialect).toBe("unknown")
  })
})
