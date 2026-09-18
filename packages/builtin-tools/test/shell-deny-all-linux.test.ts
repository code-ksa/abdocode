/**
 * CL-16A2-B §6/§7 — Linux `deny_all`, END TO END THROUGH THE REAL SHELL.
 *
 * Everything here goes through `shellTool(...).run(...)` — the same object the
 * model reaches — and never through `isolation.ts` directly. A test that drives
 * the isolation module proves the module works; only this proves the PATH the
 * model takes is isolated.
 *
 * THE CONTROL IS THE WHOLE METHOD. Each vector is first run WITHOUT isolation.
 * A vector the control could not exercise (no `curl` installed, DNS already
 * unreachable, a network that drops the protocol anyway) is recorded UNKNOWN and
 * is NOT used to prove blocking — otherwise a machine that was simply offline
 * would produce a full sheet of green "blocked" results proving nothing. That
 * exact false negative was measured earlier in this slice: run in Git bash on
 * Windows, every probe reported BLOCKED because `unshare` was not installed and
 * every command exited 127.
 *
 * The mechanism is the one CL-16A measured and nothing else: `unshare --user
 * --map-root-user --net`, unprivileged, per-process, gone when the process is.
 * No sudo, no firewall rule, no proxy variable, no global state, nothing to
 * clean up after a crash.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DENY_ALL_PROFILE, INHERIT_PROFILE, UNMEASURED_CAPABILITY, probeIsolation, type ControlledExecutionGrant, type IsolationCapabilityReport } from "@abdo/tools"
import { shellTool } from "../src/shell"

const LINUX = process.platform === "linux"
const WS = LINUX ? realpathSync(mkdtempSync(join(tmpdir(), "abdo-denyall-"))) : tmpdir()
const shell = shellTool(WS)

/** MEASURED once. On a non-Linux host this is never consulted. */
const CAPABILITY: IsolationCapabilityReport = LINUX ? probeIsolation() : UNMEASURED_CAPABILITY
const ENFORCEABLE = LINUX && CAPABILITY.denyAll === "supported" && CAPABILITY.childInheritance === "supported"

const grant = (profile = DENY_ALL_PROFILE): ControlledExecutionGrant => ({
  profile,
  capability: CAPABILITY,
  approvalGranted: false,
})

interface Run {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly failureClass?: string
}

/** Run a command through the REAL shell tool, isolated or not. */
async function run(command: string, opts: { isolated: boolean; timeoutMs?: number; signal?: AbortSignal } = { isolated: true }): Promise<Run> {
  const res = await shell.run(
    { command, timeoutMs: opts.timeoutMs ?? 25_000 },
    { dryRun: false, execution: grant(opts.isolated ? DENY_ALL_PROFILE : INHERIT_PROFILE), ...(opts.signal ? { signal: opts.signal } : {}) },
  )
  const out = (res.output ?? {}) as Partial<Run>
  return {
    ok: res.ok,
    exitCode: out.exitCode ?? null,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
    timedOut: out.timedOut ?? false,
    aborted: out.aborted ?? false,
    failureClass: out.failureClass,
  }
}

const have = async (bin: string) => LINUX && (await run(`command -v ${bin} >/dev/null`, { isolated: false })).ok

// The one thing every network vector reduces to: can this process open an
// outbound socket. `/dev/tcp` is bash-internal, so it needs no installed tool.
const TCP = "exec 3<>/dev/tcp/8.8.8.8/53"

describe.skipIf(!LINUX)("CL-16A2-B §6 — the Linux deny_all primitive", () => {
  test("the capability was MEASURED, not assumed", () => {
    expect(CAPABILITY.platform).toBe("linux")
    expect(CAPABILITY.mechanism).toBe("linux-userns-unshare")
    // Unprivileged and leaving nothing behind is what makes it acceptable at all.
    expect(CAPABILITY.requiresElevation).toBe(false)
    expect(CAPABILITY.mutatesGlobalState).toBe(false)
    if (!ENFORCEABLE) {
      console.warn(`deny_all is NOT enforceable here (denyAll=${CAPABILITY.denyAll}, child=${CAPABILITY.childInheritance}): ${CAPABILITY.reasonCodes.join("; ")}`)
    }
  })

  test("the loopback policy inside deny_all is DOCUMENTED, not incidental", async () => {
    if (!ENFORCEABLE) return
    // A fresh network namespace has `lo` DOWN, so deny_all denies the network
    // INCLUDING loopback. Asserted from two independent directions — the kernel's
    // own view and the capability probe — so they cannot drift apart again. They
    // did: CL-16A recorded loopback as "up" because its canary tested `bind()`,
    // which succeeds on a DOWN interface. Binding is not connectivity.
    const r = await run("ip addr show lo 2>/dev/null || echo NO-IP-TOOL")
    if (r.stdout.includes("NO-IP-TOOL")) return // unknown: cannot judge without `ip`
    expect(r.stdout).toContain("state DOWN")
    expect(CAPABILITY.loopbackInsideDenyAll).toBe("down")
  })

  test("a deny_all request is REFUSED, never downgraded, when the capability is not supported", async () => {
    // The negative direction of the same contract, proven on the real shell:
    // hand it a capability report that says no and nothing runs.
    const res = await shell.run(
      { command: "echo should-not-run" },
      { dryRun: false, execution: { profile: DENY_ALL_PROFILE, capability: { ...CAPABILITY, denyAll: "unsupported" }, approvalGranted: false } },
    )
    expect(res.ok).toBe(false)
    expect((res.output as { failureClass: string }).failureClass).toBe("isolation_refused")
    expect((res.output as { stdout: string }).stdout).toBe("")
  })
})

describe.skipIf(!LINUX)("CL-16A2-B §7 — every egress vector, control first", () => {
  const vectors: { name: string; command: string; needs?: string }[] = [
    { name: "direct TCP", command: TCP },
    { name: "DNS", command: "getent hosts example.com >/dev/null" },
    { name: "HTTP via curl", command: "curl -sS -m 6 -o /dev/null http://example.com", needs: "curl" },
    { name: "a child bash", command: `bash -c '${TCP}'` },
    { name: "a GRANDCHILD bash", command: `bash -c "bash -c '${TCP}'"` },
    { name: "a nested LOGIN bash", command: `bash -lc '${TCP}'` },
    { name: "python3", command: `python3 -c "import socket; socket.create_connection(('8.8.8.8',53),timeout=6).close()"`, needs: "python3" },
    { name: "node", command: `node -e "require('net').connect(53,'8.8.8.8').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),6000)"`, needs: "node" },
    { name: "bun", command: `bun -e "const s=await Bun.connect({hostname:'8.8.8.8',port:53,socket:{data(){}}}); s.end()"`, needs: "bun" },
    { name: "git over the network", command: "git ls-remote https://github.com/git/git HEAD >/dev/null", needs: "git" },
    { name: "a PATH-manipulated child", command: `PATH=/tmp:/usr/bin:/bin bash -c '${TCP}'` },
    { name: "an env-scrubbed child", command: `env -i /bin/bash -c '${TCP}'` },
  ]

  for (const v of vectors) {
    test(`${v.name}: reachable WITHOUT isolation, blocked WITH it`, async () => {
      if (v.needs && !(await have(v.needs))) {
        console.warn(`SKIPPED-UNKNOWN ${v.name}: '${v.needs}' is not installed; a control that cannot fire proves nothing`)
        return
      }
      // CONTROL: the vector must actually work here, or a "blocked" result below
      // would be indistinguishable from a machine that is simply offline.
      const control = await run(v.command, { isolated: false })
      if (!control.ok) {
        console.warn(`SKIPPED-UNKNOWN ${v.name}: the control did not succeed (exit ${control.exitCode}); not used to prove blocking`)
        return
      }
      if (!ENFORCEABLE) {
        console.warn(`SKIPPED-UNKNOWN ${v.name}: deny_all is not enforceable on this host`)
        return
      }
      const isolated = await run(v.command)
      expect(isolated.ok).toBe(false)
      // And it failed for the right reason: the process RAN and could not reach
      // the network, rather than never starting.
      expect(isolated.failureClass).not.toBe("isolation_refused")
    }, 90_000)
  }
})

describe.skipIf(!LINUX)("CL-16A2-B §7 — the isolated process is still a NORMAL process", () => {
  test("stdout, stderr and the exit code all arrive from inside the namespace", async () => {
    if (!ENFORCEABLE) return
    const r = await run('printf out; printf err >&2; exit 7')
    expect(r.stdout).toBe("out")
    expect(r.stderr).toBe("err")
    expect(r.exitCode).toBe(7)
  })

  test("local work still succeeds — deny_all denies the NETWORK, not the run", async () => {
    if (!ENFORCEABLE) return
    const r = await run('printf hello > f.txt && cat f.txt')
    expect(r.ok).toBe(true)
    expect(r.stdout).toBe("hello")
  })

  test("a timeout kills the isolated process", async () => {
    if (!ENFORCEABLE) return
    const r = await run("sleep 40", { isolated: true, timeoutMs: 1_200 })
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
  }, 60_000)

  test("cancellation from OUTSIDE the namespace kills the isolated process", async () => {
    if (!ENFORCEABLE) return
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 600)
    const r = await run("sleep 40", { isolated: true, timeoutMs: 40_000, signal: ac.signal })
    expect(r.aborted).toBe(true)
  }, 60_000)

  test("cancellation reaches a GRANDCHILD inside the namespace", async () => {
    if (!ENFORCEABLE) return
    // The grandchild writes a marker only if it survives long enough. If the
    // kill reached it, the marker never appears.
    const marker = join(WS, `grandchild-${Date.now()}.marker`)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 700)
    await run(`bash -c 'bash -c "sleep 6; touch ${marker}"'`, { isolated: true, timeoutMs: 40_000, signal: ac.signal })
    await Bun.sleep(9_000) // outlive the grandchild's sleep
    expect(existsSync(marker)).toBe(false)
  }, 60_000)
})
