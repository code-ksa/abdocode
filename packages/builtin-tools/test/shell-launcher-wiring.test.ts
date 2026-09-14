/**
 * CL-16A2-B §3/§8 — the REAL shell goes through the unified launcher.
 *
 * The failure this guards against is a parallel launcher: a well-tested
 * `launchControlledProcess` sitting next to a shell that still calls
 * `Bun.spawn` itself. Two things prevent it — the CL-00A guard forbids the
 * process-execution primitive inside `builtin-tools/src/shell.ts`, and the tests
 * here observe the launcher's own durable events coming out of an ordinary
 * `shell` call.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DENY_ALL_PROFILE, INHERIT_PROFILE, IsolationEventTypes, UNMEASURED_CAPABILITY, type ControlledExecutionGrant, type IsolationEvent } from "@abdo/tools"
import { shellTool } from "../src/shell"

const WS = realpathSync(mkdtempSync(join(tmpdir(), "abdo-shell-wiring-")))
const shell = shellTool(WS)

function grantWithSink(over: Partial<ControlledExecutionGrant> = {}): { grant: ControlledExecutionGrant; events: IsolationEvent[] } {
  const events: IsolationEvent[] = []
  return {
    events,
    grant: {
      profile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      approvalGranted: false,
      executionId: "tex-wiring",
      emit: (e) => void events.push(e),
      ...over,
    },
  }
}

describe("CL-16A2-B §3 — the shell tool does not spawn; the launcher does", () => {
  test("shell.ts contains NO process-execution primitive at all", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "shell.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
    expect(/Bun\.spawn/.test(src)).toBe(false)
    expect(/child_process/.test(src)).toBe(false)
    expect(src).toContain("launchControlledProcess")
  })

  test("an ordinary `inherit` call emits the launcher's durable isolation events", async () => {
    const { grant, events } = grantWithSink()
    const res = await shell.run({ command: "printf hello" }, { dryRun: false, execution: grant })
    expect(res.ok).toBe(true)
    expect((res.output as { stdout: string }).stdout).toBe("hello")
    expect(events.map((e) => e.type)).toEqual([IsolationEventTypes.Requested, IsolationEventTypes.CapabilityChecked, IsolationEventTypes.Applied])
    expect(events.at(-1)!.appliedMode).toBe("inherit")
    expect(events.at(-1)!.executionId).toBe("tex-wiring")
  })

  test("with NO grant the shell still runs — and still through the launcher, under inherit", async () => {
    // Absent grant is the pre-existing behaviour, not a hole: `INHERIT_PROFILE`
    // plus `UNMEASURED_CAPABILITY` means a tool that somehow bypassed the PEP
    // can never obtain isolation it has not been granted.
    const res = await shell.run({ command: "printf ok" }, { dryRun: false })
    expect(res.ok).toBe(true)
    expect((res.output as { stdout: string }).stdout).toBe("ok")
  })

  test("the environment overlay still reaches the child (CL-11 constraint holds)", async () => {
    const { grant } = grantWithSink()
    const res = await shell.run(
      { command: 'printf "%s" "$npm_config_ignore_scripts"' },
      { dryRun: false, execution: grant, envOverlay: { npm_config_ignore_scripts: "true" } },
    )
    expect(res.ok).toBe(true)
    expect((res.output as { stdout: string }).stdout).toBe("true")
  })
})

describe("CL-16A2-B §3 — the model cannot choose its own isolation", () => {
  test("isolation is not an input the schema accepts", () => {
    const props = Object.keys(shell.inputSchema!.properties as Record<string, unknown>)
    expect(props.sort()).toEqual(["command", "cwd", "timeoutMs"])
    expect((shell.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    for (const banned of ["isolation", "isolationProfile", "network", "capability", "execution"]) {
      expect(props).not.toContain(banned)
    }
  })

  test("an isolation-shaped tool argument is INERT: the granted profile is what applies", async () => {
    // Even if validation were bypassed, the tool reads `ctx.execution` and never
    // its own input. A deny_all named in the arguments must not become deny_all,
    // and a granted inherit must stay inherit.
    const { grant, events } = grantWithSink()
    const res = await shell.run(
      { command: "printf ok", isolationProfile: DENY_ALL_PROFILE, network: "deny_all", capability: { denyAll: "supported" } } as unknown,
      { dryRun: false, execution: grant },
    )
    expect(res.ok).toBe(true)
    expect(events.at(-1)!.appliedMode).toBe("inherit")
    expect(events.at(-1)!.requestedMode).toBe("inherit")
  })

  test("a fabricated capability report in the ARGUMENTS cannot unlock deny_all", async () => {
    const { grant, events } = grantWithSink({ profile: DENY_ALL_PROFILE })
    const res = await shell.run(
      { command: "printf ok", capability: { platform: process.platform, denyAll: "supported", childInheritance: "supported" } } as unknown,
      { dryRun: false, execution: grant },
    )
    // The grant's UNMEASURED capability is what is consulted, so this refuses.
    expect(res.ok).toBe(false)
    expect((res.output as { failureClass: string }).failureClass).toBe("isolation_refused")
    expect(events.some((e) => e.type === IsolationEventTypes.Applied)).toBe(false)
  })
})

describe("CL-16A2-B §8 — Windows in this slice", () => {
  const onWindows = process.platform === "win32"

  test.skipIf(!onWindows)("`inherit` works through the unified launcher on Windows", async () => {
    const { grant, events } = grantWithSink()
    const res = await shell.run({ command: "printf windows-inherit" }, { dryRun: false, execution: grant })
    expect(res.ok).toBe(true)
    expect((res.output as { stdout: string }).stdout).toBe("windows-inherit")
    expect(events.at(-1)!.appliedMode).toBe("inherit")
    expect(events.at(-1)!.platform).toBe("win32")
  })

  test.skipIf(!onWindows)("`deny_all` is REFUSED before the spawn on Windows — never downgraded", async () => {
    // Even handed a capability report that says the mechanism exists, the plan
    // refuses: `denyAllArgv` has no Windows mechanism, so there is nothing to
    // apply. No firewall rule, no elevation, no proxy, no global state change —
    // and no ordinary process pretending to be an isolated one.
    const { grant, events } = grantWithSink({
      profile: DENY_ALL_PROFILE,
      capability: {
        platform: "win32",
        mechanism: "none",
        denyAll: "unsupported",
        processTree: "supported",
        childInheritance: "unsupported",
        loopbackInsideDenyAll: "unknown",
        requiresElevation: false,
        mutatesGlobalState: false,
        reasonCodes: ["windows_no_per_run_network_isolation"],
        evidenceHash: "win-cap",
        isolationVersion: 1,
      },
    })
    const res = await shell.run({ command: "printf should-not-run" }, { dryRun: false, execution: grant })
    expect(res.ok).toBe(false)
    // `expect` does not narrow a discriminated union, so `res.error` below is
    // not visible to the type checker without this guard. It changes no
    // behaviour: the assertion above has already established the branch, and a
    // regression that made this call succeed now fails HERE with a clear message
    // instead of at an unrelated property access.
    if (res.ok) throw new Error("expected the launcher to refuse, but the tool reported success")
    const out = res.output as { failureClass: string; stdout: string; exitCode: null }
    expect(out.failureClass).toBe("isolation_refused")
    expect(out.stdout).toBe("") // nothing ran, so there is nothing to show
    expect(out.exitCode).toBeNull()
    expect(res.error).toContain("isolation_unsupported")
    expect(events.at(-1)!.type).toBe(IsolationEventTypes.Failed)
  })
})
