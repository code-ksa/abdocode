/**
 * CL-11.4D-A — Poetry install SOURCE classification, from the command alone.
 *
 * Same 4-layer shape as pip: classify (here) -> source verifier -> target
 * confinement -> enforcement. This layer is PURE and command-only, so it needs
 * no Poetry on the machine.
 *
 * What it must NOT do is guess Poetry's runtime behaviour. Poetry is not
 * installed on either platform here, so every claim that would require running
 * it — does `install` execute build backends for the root project, does any flag
 * genuinely suppress that, where does it put its virtualenv — stays `unknown`.
 * The house rule from CL-11's suppression measurement stands: unmeasured is
 * `unknown`, never `no`. Slice 4D-B is where those get measured.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessPoetryInstallSource } from "../src/index"

const A = (cmd: string) => assessPoetryInstallSource(normalize(cmd, {}).commands ?? [])

describe("CL-11.4D-A what is and is not a Poetry install", () => {
  test("`poetry install` is an install", () => {
    const a = A("poetry install")
    expect(a.isInstall).toBe(true)
    expect(a.verb).toBe("install")
  })

  test("add / update / lock / sync are recognised as their own verbs", () => {
    for (const [cmd, verb] of [["poetry add requests", "add"], ["poetry update", "update"], ["poetry lock", "lock"], ["poetry sync", "sync"]] as const) {
      expect(A(cmd).verb).toBe(verb)
    }
  })

  test("`poetry run` is NOT an install — it is arbitrary execution", () => {
    const a = A("poetry run python evil.py")
    expect(a.isInstall).toBe(false)
    expect(a.verb).toBe("run")
    expect(a.blockers).toContain("poetry_run_executes_arbitrary_code")
  })

  test("non-poetry commands are not claimed", () => {
    for (const cmd of ["npm ci", "python -m pip install -r r.txt", "ls"]) {
      expect(A(cmd).isInstall).toBe(false)
    }
  })

  test("a poetry invoked by path is still poetry", () => {
    expect(A("./.venv/bin/poetry install").isInstall).toBe(true)
    expect(A("python -m poetry install").isInstall).toBe(true)
  })
})

describe("CL-11.4D-A verbs that RESOLVE rewrite the lockfile", () => {
  test("add / update / lock re-resolve, so they are never the deterministic path", () => {
    for (const cmd of ["poetry add requests", "poetry update", "poetry lock"]) {
      const a = A(cmd)
      expect(a.resolvesDependencies).toBe(true)
      expect(a.blockers).toContain("poetry_resolves_and_rewrites_lock")
    }
  })

  test("`poetry install` consumes the existing lock rather than re-resolving", () => {
    const a = A("poetry install")
    expect(a.resolvesDependencies).toBe(false)
    expect(a.blockers).not.toContain("poetry_resolves_and_rewrites_lock")
  })
})

describe("CL-11.4D-B the root is installed EDITABLE, and the builds come from deps", () => {
  test("`poetry install` installs the root — but MEASURED, it does not build it", () => {
    // 4D-A assumed root install implied build execution. 4D-B disproved that
    // with markers: zero PEP 517 hooks fired, for a custom backend AND for a
    // setuptools root, against a control showing the backend fires when called
    // directly. Poetry installs the root as a `.pth` into site-packages.
    const a = A("poetry install")
    expect(a.installsRootProject).toBe("yes")
    expect(a.blockers).toContain("poetry_root_installed_editable")
  })

  test("`--no-root` excludes the root and NOTHING else — deps still build", () => {
    // MEASURED: with --no-root, a path dep (plain and develop), an sdist and a
    // git dep all executed their setup.py.
    const a = A("poetry install --no-root")
    expect(a.installsRootProject).toBe("no")
    expect(a.blockers).not.toContain("poetry_root_installed_editable")
    expect(a.buildExecution).toBe("yes")
    expect(a.blockers).toContain("build_may_execute")
  })

  test("there is no `--only-binary :all:` equivalent, so build execution is never `no`", () => {
    // MEASURED on 1.8.3: `poetry install --help` offers no binary/no-build flag,
    // and `installer.no-binary` is the INVERSE (forces source builds), default
    // null. So no command shape can currently prove "no build".
    for (const cmd of ["poetry install", "poetry install --no-root", "poetry install --sync --no-root --only main"]) {
      expect(A(cmd).buildExecution).toBe("yes")
      expect(A(cmd).blockers).toContain("build_may_execute")
    }
  })
})

describe("CL-11.4D-A the environment Poetry writes to is not on the command", () => {
  test("a bare `poetry install` names no interpreter => target unknown", () => {
    const a = A("poetry install --no-root")
    expect(a.target.interpreter).toBeUndefined()
    expect(a.blockers).toContain("poetry_env_unresolved")
  })

  test("`poetry env use <python>` names one, and is itself an env mutation", () => {
    const a = A("poetry env use ./.venv/bin/python")
    expect(a.verb).toBe("env")
    expect(a.target.interpreter).toBe("./.venv/bin/python")
    expect(a.blockers).toContain("poetry_env_mutation")
  })
})

describe("CL-11.4D-A flags that widen or redirect the install", () => {
  test("`--extras` / `--all-extras` / `--with` widen the set beyond the default group", () => {
    for (const cmd of ["poetry install --all-extras", "poetry install --with dev", "poetry install --extras fast"]) {
      expect(A(cmd).widensDependencySet).toBe(true)
    }
    expect(A("poetry install --only main").widensDependencySet).toBe(false)
  })

  test("a compound command is judged worst-wins", () => {
    const a = A("poetry install --no-root && poetry add requests")
    expect(a.isInstall).toBe(true)
    expect(a.blockers).toContain("poetry_resolves_and_rewrites_lock")
  })
})

describe("CL-11.4D-A nothing here auto-allows yet", () => {
  test("even the tightest command still carries blockers — 4D-B/C are not built", () => {
    // The deterministic-looking shape. It must NOT come back clean: the source
    // verifier (poetry.lock content-hash + per-package hashes + [[tool.poetry.
    // source]] repositories) and the target confinement do not exist yet, and
    // Poetry's own behaviour is unmeasured on this machine.
    const a = A("poetry install --no-root --sync")
    expect(a.blockers.length).toBeGreaterThan(0)
    expect(a.blockers).toContain("poetry_verifier_not_implemented")
  })
})
