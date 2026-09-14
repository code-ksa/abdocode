/**
 * CL-11 slice 2 — the enforcement, proved against a REAL npm.
 *
 * An environment overlay is only a claim until a package manager is asked to
 * disobey it. This runs `npm install` through the whole path — decision point,
 * enforcement point, shell tool, `Bun.spawn` — over a fixture with TWO scripts
 * that write marker files:
 *
 *   - a `file:` dependency's `postinstall`  (third-party code)
 *   - the root project's own `preinstall`/`postinstall`/`prepare`
 *
 * The IMPLICIT scripts here — the dependency's postinstall and the root's own
 * preinstall/postinstall — are what the overlay suppresses, so both markers must be
 * absent. A test that only watched the dependency would pass while the repo's
 * own hooks ran.
 *
 * Slow by nature (a real install per case) and skipped where npm is absent —
 * skipped, never silently green.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { delimiter, join } from "node:path"
import { homedir } from "node:os"
import { tmpdir } from "node:os"
import {
  CONTROL_CONTRACT_VERSION,
  policy,
  PolicyToolRunner,
  ToolRegistry,
  type ControlDecision,
  type ControlRequest,
  type PolicyDecisionPoint,
} from "@abdo/tools"
import { shellTool } from "../src/index"

/**
 * CL-16A2 §0 — these tests need a npm that can actually RUN here.
 *
 * On WSL, `Bun.which("npm")` finds the WINDOWS npm through `/mnt/c`, which fails
 * (exit 28) against a Linux fixture — so the suite reported four failures that
 * were an environment artefact, not a defect. A pinned NATIVE Linux Node lab
 * lives outside the repo at `~/.abdo/labs/node/<version>`; when it is present
 * its `bin` goes first on PATH for the commands these tests spawn. Nothing is
 * installed globally and no PATH change outlives the process.
 */
const NODE_LAB_BIN = (() => {
  const root = join(homedir(), ".abdo", "labs", "node")
  try {
    for (const version of readdirSync(root)) {
      for (const inner of readdirSync(join(root, version))) {
        const bin = join(root, version, inner, "bin")
        if (existsSync(join(bin, "npm"))) return bin
      }
    }
  } catch {}
  return undefined
})()

/**
 * MEASURED: mutating `process.env.PATH` does NOT reach a child here — Bun
 * captures the environment at startup, so only an explicit `env:` on the spawn
 * takes effect. Every spawn these tests make therefore carries `LAB_ENV`.
 */
const LAB_ENV: NodeJS.ProcessEnv = NODE_LAB_BIN
  ? { ...process.env, PATH: `${NODE_LAB_BIN}${delimiter}${process.env["PATH"] ?? ""}` }
  : { ...process.env }

/** npm must exist AND be runnable on this platform, not merely be on PATH. */
const hasNpm = (() => {
  try {
    const p = Bun.spawnSync(["bash", "-lc", "npm --version"], { env: LAB_ENV, stdout: "pipe", stderr: "pipe", timeout: 60_000 })
    return p.exitCode === 0
  } catch {
    return false
  }
})()
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

/**
 * A workspace whose install fires a third-party hook AND a project hook.
 *
 * The scripts write a marker in their OWN working directory using single quotes
 * only: npm runs a lifecycle script through `cmd.exe /d /s /c` on Windows, and an
 * absolute path embedded in double quotes gets mangled by that layer — which
 * cost one debugging round here, and would have looked like "the constraint
 * worked" if the script had merely failed instead of writing.
 */
function fixture(): { dir: string; depMark: string; rootMark: string } {
  const dir = mkdtempSync(join(tmpdir(), "abdo-lc-"))
  dirs.push(dir)
  // A dependency's postinstall runs inside its installed directory.
  const depMark = join(dir, "node_modules", "lc-dep", "ran.mark")
  const rootMark = join(dir, "root.mark")
  const write = (name: string) => `node -e "require('fs').appendFileSync('${name}','x')"`
  mkdirSync(join(dir, "dep"))
  writeFileSync(
    join(dir, "dep", "package.json"),
    JSON.stringify({ name: "lc-dep", version: "1.0.0", scripts: { postinstall: write("ran.mark") } }, null, 2),
  )
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "lc-root",
        version: "1.0.0",
        dependencies: { "lc-dep": "file:./dep" },
        scripts: { preinstall: write("root.mark"), postinstall: write("root.mark"), prepare: write("root.mark") },
      },
      null,
      2,
    ),
  )
  return { dir, depMark, rootMark }
}

const runnerFor = (dir: string, approve: boolean, pdp?: PolicyDecisionPoint) =>
  new PolicyToolRunner(new ToolRegistry().register({ ...shellTool(dir), policy: policy({ risk: "low" }) }), {
    approver: { approve: async () => approve },
    ...(pdp ? { pdp } : {}),
  })

/**
 * The ENFORCEMENT tests below drive the constrained decision directly.
 *
 * Not a convenience: measured on this machine, the built-in decision point never
 * reaches its own allow branch for `npm install`, because CL-05 already marks a
 * package install `analysis: unknown` (it reaches hosts nobody named) and the
 * conservative floor asks first. The DECISION for installs is therefore `ask`
 * today — pinned in @abdo/tools' unit tests — while what has to be proved here
 * is that when a constrained allow IS issued, the overlay genuinely stops a real
 * npm. Mixing the two would let a decision-layer accident masquerade as
 * enforcement working, or the reverse.
 */
const constrainedPdp: PolicyDecisionPoint = {
  decide(request: ControlRequest): ControlDecision {
    const lifecycle = request.lifecycle
    // PATH rides along so the shell tool spawns the LAB npm rather than the
    // Windows one WSL exposes through /mnt/c. It is not part of what is being
    // asserted — the assertions are about marker files.
    const pathOverlay: Record<string, string> = NODE_LAB_BIN ? { PATH: LAB_ENV["PATH"]! } : {}
    if (!lifecycle?.implicitRequired) {
      return { version: CONTROL_CONTRACT_VERSION, action: "allow", ruleId: "test.plain", reasonCode: "auto_allowed_low_risk", constraints: [] }
    }
    if (!lifecycle.implicitEnforceable) return { version: CONTROL_CONTRACT_VERSION, action: "ask", ruleId: "test.lifecycle", reasonCode: "lifecycle_scripts_not_suppressible", approvalRequestId: "apr_test" }
    return {
      version: CONTROL_CONTRACT_VERSION,
      action: "allow",
      ruleId: "test.lifecycle",
      reasonCode: "auto_allowed_low_risk",
      constraints: [{ kind: "suppressImplicitLifecycleScripts", value: true, env: { ...lifecycle.envOverlay, ...pathOverlay } }],
    }
  },
}

describe.skipIf(!hasNpm)("CL-11 the constraint holds against a real npm", () => {
  test("BASELINE: without the constraint both scripts run — the fixture really fires", async () => {
    // Without this the test below could pass for the wrong reason.
    const { dir, depMark, rootMark } = fixture()
    // Through bash, like every other case here: on Windows `npm` is a shim that
    // a direct spawn cannot execute, and a baseline that fails to run would
    // "prove" the constraint by accident.
    const proc = Bun.spawnSync(["bash", "-lc", "npm install"], { cwd: dir, env: LAB_ENV })
    expect(proc.exitCode).toBe(0)
    expect(existsSync(depMark)).toBe(true)
    expect(existsSync(rootMark)).toBe(true)
  }, 180_000)

  test("through the FULL path, a constrained `npm install` runs NEITHER the dependency's nor the project's scripts", async () => {
    const { dir, depMark, rootMark } = fixture()
    const out = await runnerFor(dir, true, constrainedPdp).run({ name: "shell", input: { command: "npm install" } })

    expect(out.ok).toBe(true)
    expect(existsSync(join(dir, "node_modules"))).toBe(true) // the install really happened
    expect(existsSync(depMark)).toBe(false) // third-party hook
    expect(existsSync(rootMark)).toBe(false) // the project's own hooks
  }, 180_000)

  test("a CHAIN is covered whole — the reason enforcement is the environment, not the text", async () => {
    // `rm -rf node_modules && npm install` is the shape a rewrite could not
    // safely handle. The overlay reaches every segment.
    const { dir, depMark, rootMark } = fixture()
    const out = await runnerFor(dir, true, constrainedPdp).run({ name: "shell", input: { command: "rm -rf node_modules && npm install" } })

    expect(out.ok).toBe(true)
    expect(existsSync(depMark)).toBe(false)
    expect(existsSync(rootMark)).toBe(false)
  }, 180_000)

  test("a command that tries to undo the constraint is REFUSED — it does not run unconstrained", async () => {
    // Measured: `--ignore-scripts=false` beats the variable. So the decision
    // point refuses rather than running a command it cannot constrain. With no
    // approval available the call is denied and nothing is installed.
    const { dir, depMark, rootMark } = fixture()
    const out = await runnerFor(dir, false, constrainedPdp).run({ name: "shell", input: { command: "npm install --ignore-scripts=false" } })

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("denied")
    expect(existsSync(join(dir, "node_modules"))).toBe(false)
    expect(existsSync(depMark)).toBe(false)
    expect(existsSync(rootMark)).toBe(false)
  }, 180_000)

  test("an APPROVED command runs as written — the human authorized THAT command", async () => {
    // The other side of the same rule, and the reason it must be explicit: an
    // approval is not a constrained allow, so the scripts DO run here. This is
    // also the measured consequence worth stating plainly: because installs are
    // `ask` today, THIS is the path a real `npm install` takes end to end.
    const { dir, depMark, rootMark } = fixture()
    const out = await runnerFor(dir, true, constrainedPdp).run({ name: "shell", input: { command: "npm install --ignore-scripts=false" } })

    expect(out.ok).toBe(true)
    expect(out.control?.reasonCode).toBe("approval_granted")
    expect(out.control?.constraints).toBeUndefined()
    expect(existsSync(depMark)).toBe(true)
    expect(existsSync(rootMark)).toBe(true)
  }, 180_000)
})
