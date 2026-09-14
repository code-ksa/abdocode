/**
 * CL-11.2 gate — when may the control plane CLAIM that lifecycle scripts are
 * suppressed?
 *
 * Only when an environment overlay we have MEASURED covers every command that
 * would run scripts, and nothing in the command can undo it. Each blocker below
 * is a measured bypass, not a theoretical one (2026-07-23, npm 10.9.4, with
 * `npm_config_ignore_scripts=true` already in the environment):
 *
 *   npm install                                  -> no script   (the overlay works)
 *   npm install --ignore-scripts=false           -> SCRIPTS RAN (the flag wins)
 *   npm_config_ignore_scripts=false npm install  -> SCRIPTS RAN
 *   env npm_config_ignore_scripts=false npm ...  -> SCRIPTS RAN
 *   bash -c 'export ...=false; npm install'      -> SCRIPTS RAN
 *   rm -rf node_modules && npm install           -> no script   (chains are covered)
 *
 * A blocked case is NOT "unprotected". It is `ask`: the decision point may not
 * pretend to a protection the environment cannot deliver.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessLifecycleEnforcement } from "../src/index"
import type { NormalizedCommand } from "@abdo/control-contracts"

const enforce = (command: string, shell: "bash" | "cmd" | "powershell" = "bash") =>
  assessLifecycleEnforcement(normalize(command, { shell }), command)

/** A command the normalizer would not hand us today — used to prove the
 *  defence-in-depth check is live code, not decoration. */
const raw = (program: string, argv: string[]): NormalizedCommand => ({ program, argv, cwd: ".", env: {}, redirections: [], background: false })

describe("CL-11.2a a constraint is claimed only where it is proven to hold", () => {
  test("npm install: required, enforceable, and the overlay is the measured one", () => {
    const e = enforce("npm install")
    expect(e.implicitRequired).toBe(true)
    expect(e.implicitEnforceable).toBe(true)
    expect(e.envOverlay).toEqual({ npm_config_ignore_scripts: "true" })
    expect(e.blockers).toEqual([])
  })

  test("a chain is covered whole — that is why the overlay is the environment", () => {
    const e = enforce("rm -rf node_modules && npm install")
    expect(e.implicitRequired).toBe(true)
    expect(e.implicitEnforceable).toBe(true)
  })

  test("`npm run build`: implicit pre/post are suppressible, the named script is EXPLICIT", () => {
    // The correction. The overlay suppresses prebuild/postbuild (implicit), so
    // the constraint applies to those. It does NOT touch `build` itself, which
    // is reported as explicit code execution for the risk path to weigh.
    const e = enforce("npm run build")
    expect(e.assessment.thirdPartyScripts).toBe("no")
    expect(e.assessment.implicitProjectScripts).toBe("yes")
    expect(e.assessment.explicitScript).toBe("yes")
    expect(e.implicitRequired).toBe(true) // the wrappers are worth suppressing
    expect(e.implicitEnforceable).toBe(true)
    expect(e.explicitCodeExecution).toBe(true) // ...but the named script is not "handled" by the overlay
  })

  test("a command that runs nothing needs no constraint at all", () => {
    const e = enforce("git status")
    expect(e.implicitRequired).toBe(false)
    expect(e.implicitEnforceable).toBe(false) // nothing to enforce; `required` is what the PDP reads
    expect(e.envOverlay).toEqual({})
  })
})

describe("CL-11.2b managers without a proven overlay are ASK, never 'suppressed'", () => {
  test("yarn and bun measured to IGNORE the variable cannot be constrained", () => {
    for (const cmd of ["yarn install", "bun install"]) {
      const e = enforce(cmd)
      expect(e.implicitRequired).toBe(true)
      expect(e.implicitEnforceable).toBe(false)
      expect(e.blockers.some((b) => b.startsWith("no_proven_suppression"))).toBe(true)
    }
  })

  test("pnpm (unproven) and pip/cargo (no no-rewrite path) are the same answer", () => {
    for (const cmd of ["pnpm install", "pip install requests", "cargo build"]) {
      expect(enforce(cmd).implicitEnforceable).toBe(false)
    }
  })

  test("ONE unenforceable member poisons the whole chain", () => {
    const e = enforce("npm install && yarn install")
    expect(e.implicitEnforceable).toBe(false)
    expect(e.blockers.some((b) => b.includes("yarn"))).toBe(true)
  })
})

describe("CL-11.2c the command may not undo the constraint from the inside", () => {
  test("an inline assignment of the protected key blocks the claim", () => {
    for (const cmd of ["npm_config_ignore_scripts=false npm install", "env npm_config_ignore_scripts=false npm install"]) {
      const e = enforce(cmd)
      expect(e.implicitEnforceable).toBe(false)
      expect(e.blockers).toContain("protected_key_set_by_command")
    }
  })

  test("case does not launder it — npm reads the variable case-insensitively", () => {
    const e = enforce("NPM_CONFIG_IGNORE_SCRIPTS=false npm install")
    expect(e.implicitEnforceable).toBe(false)
  })

  test("the CLI flag beats the environment (measured), so it blocks the claim", () => {
    for (const cmd of [
      "npm install --ignore-scripts=false",
      "npm install --no-ignore-scripts",
      "npm install --ignore-scripts false",
    ]) {
      const e = enforce(cmd)
      expect(e.implicitEnforceable).toBe(false)
      expect(e.blockers).toContain("cli_flag_overrides_constraint")
    }
    // ...while asking for the same thing the constraint does is not a bypass:
    // the command already suppresses, so nothing needs to be enforced onto it.
    const already = enforce("npm install --ignore-scripts")
    expect(already.implicitRequired).toBe(false)
    expect(already.blockers).toEqual([])
  })

  test("`export` inside a chain blocks it — the normalizer unwraps it, so we see it", () => {
    const e = enforce("bash -c 'export npm_config_ignore_scripts=false; npm install'")
    expect(e.implicitEnforceable).toBe(false)
    expect(e.blockers).toContain("protected_key_set_by_command")
  })

  test("cmd `set VAR=false && npm install`: the PARSE DROPS the assignment — the raw text catches it", () => {
    // Measured 2026-07-23: the normalizer returns only `npm install` for this
    // line, with an empty env. A purely structural check would have called it
    // enforceable and been wrong in the real shell.
    const e = enforce("set npm_config_ignore_scripts=false && npm install", "cmd")
    expect(e.implicitEnforceable).toBe(false)
    expect(e.blockers).toContain("protected_key_written_in_raw_command")
  })

  test("PowerShell `$env:key=` blocks it too", () => {
    const e = enforce('$env:npm_config_ignore_scripts="false"; npm install', "powershell")
    expect(e.implicitEnforceable).toBe(false)
  })

  test("an UNCERTAIN parse can never carry a claim", () => {
    const e = enforce('npm install; eval "$CMD"', "powershell")
    expect(e.implicitEnforceable).toBe(false)
    expect(e.blockers).toContain("uncertain_parse")
  })

  test("a nested shell is caught — today by the parser, and by our own net behind it", () => {
    // Measured: `npm install && bash ./setup.sh` makes the normalizer report
    // `uncertain` and drop the nested command entirely, so THAT is the blocker
    // this input produces today.
    const viaParser = enforce("npm install && bash ./setup.sh")
    expect(viaParser.implicitEnforceable).toBe(false)
    expect(viaParser.blockers).toContain("uncertain_parse")

    // The interpreter check behind it is live code, not decoration: were a
    // future normalizer to resolve such a command confidently, an unread script
    // could still unset the variable the constraint rests on.
    const direct = assessLifecycleEnforcement(
      { certainty: "parsed", commands: [raw("npm", ["install"]), raw("bash", ["./setup.sh"])] },
      "npm install && bash ./setup.sh",
    )
    expect(direct.implicitEnforceable).toBe(false)
    expect(direct.blockers).toContain("opaque_nested_shell")
  })

  test("an UNMODELLED program is not blessed here — it is escalated by the risk path", () => {
    // `xargs` is not a package manager, so demanding a package-manager overlay
    // from it would misfile the problem. It has no known capability either,
    // which makes the whole operation conservative and sends it to approval —
    // asserted end-to-end in the PDP tests, not papered over here.
    const e = enforce("npm install && xargs sh")
    expect(e.implicitRequired).toBe(true)
    expect(e.blockers).toEqual([])
  })
})
