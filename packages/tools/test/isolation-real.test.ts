/**
 * CL-16A — the isolation mechanism, measured on the real machine.
 *
 * `isolation.test.ts` proves the planner refuses correctly given a capability
 * report. This file produces that report by actually creating a namespace and
 * actually trying to reach the network from inside it — including from a
 * grandchild behind a nested shell, which is where a weaker mechanism leaks.
 *
 * Every negative result is paired with a CONTROL that must reach the network,
 * because "blocked" on an offline machine proves nothing. On a platform with no
 * per-run mechanism the suite asserts that we SAY SO rather than falling back.
 */
import { describe, expect, test } from "bun:test"
import { denyAllArgv, planIsolatedSpawn, probeIsolation, DENY_ALL_PROFILE, defaultSpawner } from "../src/index"

const PLATFORM = process.platform
const LINUX = PLATFORM === "linux"
const python = LINUX ? "python3" : "python"
const TMO = 180_000

/** Can we even run the canary interpreter here? */
function haveInterpreter(): boolean {
  try {
    return defaultSpawner([python, "-c", "print(1)"]).exitCode === 0
  } catch {
    return false
  }
}
const HAVE_PY = haveInterpreter()
/** `unshare` present AND usable unprivileged. */
const HAVE_UNSHARE = LINUX && (() => {
  try {
    return defaultSpawner(["unshare", "--user", "--map-root-user", "--net", "true"]).exitCode === 0
  } catch {
    return false
  }
})()

describe.skipIf(!LINUX || !HAVE_PY || !HAVE_UNSHARE)("CL-16A Linux deny_all, measured", () => {
  const report = probeIsolation({ python })

  test("CONTROL: without isolation this machine reaches the network", () => {
    // If this fails every "blocked" below is meaningless, so it is asserted
    // first and separately.
    const r = defaultSpawner([python, "-c", "import socket;s=socket.create_connection(('8.8.8.8',53),timeout=5);s.close();print('ok')"])
    expect(r.stdout.trim()).toBe("ok")
  }, TMO)

  test("the probe reports deny_all as SUPPORTED, unprivileged, no global state", () => {
    expect(report.denyAll).toBe("supported")
    expect(report.mechanism).toBe("linux-userns-unshare")
    expect(report.requiresElevation).toBe(false)
    expect(report.mutatesGlobalState).toBe(false)
    // Only reason codes about protocols the control could not reach are
    // acceptable here; anything else would mean the mechanism itself faltered.
    for (const c of report.reasonCodes) expect(c).toMatch(/^control_(tcp|dns|udp)_unavailable_not_judged$/)
  }, TMO)

  test("inside deny_all: DNS and TCP both fail", () => {
    const argv = denyAllArgv([python, "-c",
      "import socket,json;r={}\n" +
      "socket.setdefaulttimeout(4)\n" +
      "try:\n socket.getaddrinfo('example.com',80); r['dns']='ok'\nexcept Exception: r['dns']='blocked'\n" +
      "try:\n s=socket.create_connection(('8.8.8.8',53),timeout=4); s.close(); r['tcp']='ok'\nexcept Exception: r['tcp']='blocked'\n" +
      "try:\n u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); u.settimeout(3); u.sendto(b'x',('8.8.8.8',53)); u.close(); r['udp']='ok'\nexcept Exception: r['udp']='blocked'\n" +
      "print(json.dumps(r))"], "linux")!
    const out = defaultSpawner(argv)
    const r = JSON.parse(out.stdout.trim())
    // DNS and TCP are judged: the control proved both reachable here. UDP is
    // reported but NOT asserted — WSL2's NAT drops outbound UDP with no
    // isolation at all, so it is not something the namespace can be credited for.
    expect(r.dns).toBe("blocked")
    expect(r.tcp).toBe("blocked")
  }, TMO)

  test("a GRANDCHILD behind a nested shell does not regain the network", () => {
    expect(report.childInheritance).toBe("supported")
    // Two shells deep, then the interpreter. The script travels as an argv
    // element so no quoting can turn a failed launch into a false "contained".
    const probe = [
      "import socket",
      "try:",
      "    s=socket.create_connection(('8.8.8.8',53),timeout=4); s.close(); print('ESCAPED')",
      "except Exception: print('contained')",
    ].join("\n")
    const argv = denyAllArgv(["sh", "-c", 'exec "$0" "$@"', "sh", "-c", 'exec "$0" "$@"', python, "-c", probe], "linux")!
    const out = defaultSpawner(argv)
    expect(out.stdout).toContain("contained")
    expect(out.stdout).not.toContain("ESCAPED")
  }, TMO)

  test("changing PATH does not escape the namespace", () => {
    const argv = denyAllArgv([python, "-c",
      "import socket\ntry:\n s=socket.create_connection(('8.8.8.8',53),timeout=4); s.close(); print('ESCAPED')\nexcept Exception: print('contained')"], "linux")!
    const out = defaultSpawner(argv, { env: { ...process.env, PATH: `/tmp:${process.env["PATH"] ?? ""}` } })
    expect(out.stdout).toContain("contained")
  }, TMO)

  test("an HTTP client inside the namespace fails", () => {
    const argv = denyAllArgv([python, "-c",
      "import urllib.request\ntry:\n urllib.request.urlopen('http://example.com', timeout=5); print('ESCAPED')\nexcept Exception: print('contained')"], "linux")!
    expect(defaultSpawner(argv).stdout).toContain("contained")
  }, TMO)

  test("loopback policy is DOCUMENTED, not incidental", () => {
    // CORRECTED 2026-07-26 (CL-16A2-B). CL-16A recorded "deny_all keeps loopback
    // UP: a namespace has its own lo". That was WRONG, and the probe agreed with
    // it for the wrong reason: the canary tested loopback with `bind()`, which
    // succeeds inside a fresh network namespace even though `lo` is DOWN. A
    // round-trip canary (listen, then connect) and `ip addr show lo` both report
    // DOWN.
    //
    // The policy therefore IS total: deny_all denies the network including
    // loopback. A tool that talks to itself over 127.0.0.1 does not work inside
    // it. That is a real constraint on what may be run isolated, and it is
    // written down here rather than discovered later by a confusing failure.
    expect(report.loopbackInsideDenyAll).toBe("down")
  }, TMO)

  test("the planner ACCEPTS this real report and wraps the argv", () => {
    const plan = planIsolatedSpawn({
      argv: [python, "-c", "print(1)"], cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "" },
      profile: DENY_ALL_PROFILE, capability: report,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.applied).toBe("deny_all")
    // And the planned argv really does block the network when run.
    const out = defaultSpawner([...plan.argv.slice(0, 4), python, "-c",
      "import socket\ntry:\n s=socket.create_connection(('8.8.8.8',53),timeout=4); s.close(); print('ESCAPED')\nexcept Exception: print('contained')"])
    expect(out.stdout).toContain("contained")
  }, TMO)
})

describe.skipIf(LINUX)("CL-16A this platform has NO per-run isolation", () => {
  test("the probe says unsupported, with the reason, and never pretends", () => {
    const report = probeIsolation({ python })
    expect(report.denyAll).toBe("unsupported")
    expect(report.mechanism).toBe("none")
    expect(report.reasonCodes.length).toBeGreaterThan(0)
  })

  test("a deny_all request is REFUSED here — no ordinary process is planned", () => {
    const plan = planIsolatedSpawn({
      argv: ["python", "-c", "print(1)"], cwd: process.cwd(), env: {},
      profile: DENY_ALL_PROFILE, capability: probeIsolation({ python }),
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reasonCode).toBe("isolation_unsupported")
  })
})

describe.skipIf(!LINUX || HAVE_UNSHARE)("CL-16A Linux without usable unshare", () => {
  test("SKIPPED-EQUIVALENT: unshare is unavailable, so deny_all must be unsupported", () => {
    // Some distributions disable unprivileged user namespaces. That is a real
    // configuration, and it must degrade to `unsupported`, never to a plain run.
    const report = probeIsolation({ python })
    expect(report.denyAll).not.toBe("supported")
    expect(planIsolatedSpawn({
      argv: ["true"], cwd: process.cwd(), env: {}, profile: DENY_ALL_PROFILE, capability: report,
    }).ok).toBe(false)
  })
})
