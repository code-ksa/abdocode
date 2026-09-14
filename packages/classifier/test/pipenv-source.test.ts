/**
 * CL-11.4E-A — Pipenv install SOURCE classification, from the command alone.
 *
 * Written BEFORE Pipenv was installed anywhere, deliberately: this layer is pure
 * command parsing and must not depend on a runtime. Every claim that would need
 * a real Pipenv to settle — where the virtualenv lands, whether `--deploy`
 * really refuses a stale lock, whether any flag prevents a build — is `unknown`
 * here and gets measured in 4E-B. The rule from CL-11's suppression measurement
 * holds unchanged: unmeasured is `unknown`, never `no`.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessPipenvInstallSource } from "../src/index"

const A = (cmd: string) => assessPipenvInstallSource(normalize(cmd, {}).commands ?? [])

describe("CL-11.4E-A what is and is not a Pipenv install", () => {
  test("the install-shaped verbs are recognised", () => {
    for (const [cmd, verb] of [
      ["pipenv install", "install"],
      ["pipenv sync", "sync"],
      ["pipenv update", "update"],
      ["pipenv lock", "lock"],
    ] as const) {
      const a = A(cmd)
      expect(a.verb).toBe(verb)
    }
    expect(A("pipenv install").isInstall).toBe(true)
    expect(A("pipenv sync").isInstall).toBe(true)
    expect(A("pipenv lock").isInstall).toBe(false)   // lock writes no environment
  })

  test("`pipenv run` and `pipenv shell` are arbitrary execution, not installs", () => {
    for (const cmd of ["pipenv run python evil.py", "pipenv shell"]) {
      const a = A(cmd)
      expect(a.isInstall).toBe(false)
      expect(a.blockers).toContain("pipenv_executes_arbitrary_code")
    }
  })

  test("non-pipenv commands are not claimed", () => {
    for (const cmd of ["npm ci", "poetry install", "python -m pip install -r r.txt", "ls"]) {
      expect(A(cmd).isInstall).toBe(false)
      expect(A(cmd).verb).toBeUndefined()
    }
  })

  test("a pipenv invoked by path or as a module is still pipenv", () => {
    expect(A("./.venv/bin/pipenv sync").isInstall).toBe(true)
    expect(A("python -m pipenv sync").isInstall).toBe(true)
  })
})

describe("CL-11.4E-A resolution rewrites the lock", () => {
  test("install / update / lock re-resolve unless told otherwise", () => {
    for (const cmd of ["pipenv install", "pipenv install requests", "pipenv update", "pipenv lock"]) {
      const a = A(cmd)
      expect(a.resolvesDependencies).toBe(true)
      expect(a.blockers).toContain("pipenv_resolves_and_rewrites_lock")
    }
  })

  test("`sync` consumes the existing lock rather than re-resolving", () => {
    const a = A("pipenv sync")
    expect(a.resolvesDependencies).toBe(false)
    expect(a.blockers).not.toContain("pipenv_resolves_and_rewrites_lock")
  })

  test("MEASURED 4E-B: only `install --deploy` enforces lock freshness", () => {
    // 4E-A recorded the flag as an unverified claim. 4E-B measured it on Pipenv
    // 2023.12.1 and — unlike Poetry's `--no-root` — it does what it says:
    // a stale lock gives rc=2 and "Aborting deploy".
    const deployed = A("pipenv install --deploy")
    expect(deployed.deploy).toBe(true)
    expect(deployed.lockFreshnessEnforced).toBe("yes")
    expect(deployed.blockers).not.toContain("pipenv_lock_freshness_not_enforced")

    // Plain `install` on a stale lock exits 0 and SILENTLY RE-LOCKS.
    expect(A("pipenv install").lockFreshnessEnforced).toBe("no")
    expect(A("pipenv install").blockers).toContain("pipenv_lock_freshness_not_enforced")

    // `sync` never looks at the Pipfile at all.
    expect(A("pipenv sync").lockFreshnessEnforced).toBe("no")
    expect(A("pipenv sync").blockers).toContain("pipenv_lock_freshness_not_enforced")

    expect(A("pipenv install --ignore-pipfile").ignorePipfile).toBe(true)
  })

  test("MEASURED 4E-B: `sync --deploy` is not a real command", () => {
    // rc=2, "No such option: --deploy". The one verb that checks freshness is
    // also the one that re-resolves without it — worth surfacing, not hiding.
    expect(A("pipenv sync --deploy").blockers).toContain("pipenv_sync_rejects_deploy")
  })
})

describe("CL-11.4E-A --system is an install outside any virtualenv", () => {
  test("`--system` is flagged on its own", () => {
    const a = A("pipenv install --system")
    expect(a.systemInstall).toBe(true)
    expect(a.blockers).toContain("pipenv_system_install")
  })

  test("without --system the destination is still not on the command", () => {
    const a = A("pipenv sync")
    expect(a.systemInstall).toBe(false)
    expect(a.blockers).toContain("pipenv_env_unresolved")
  })
})

describe("CL-11.4E-A nothing here can auto-allow", () => {
  test("even the tightest shape carries the not-implemented blocker", () => {
    const a = A("pipenv sync --deploy")
    expect(a.blockers).toContain("pipenv_verifier_not_implemented")
    expect(a.blockers.length).toBeGreaterThan(0)
  })

  test("build execution is unknown until measured, never `no`", () => {
    expect(A("pipenv sync").buildExecution).toBe("unknown")
    expect(A("pipenv sync").blockers).toContain("build_may_execute")
  })

  test("a compound command is judged worst-wins", () => {
    const a = A("pipenv sync && pipenv install requests")
    expect(a.isInstall).toBe(true)
    expect(a.blockers).toContain("pipenv_resolves_and_rewrites_lock")
  })
})
