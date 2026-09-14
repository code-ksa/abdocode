/**
 * CL-16A — per-run process isolation and network egress enforcement.
 *
 * Everything CL-11 deferred (Poetry, Cargo, Go auto-allow) waits on one missing
 * capability: the ability to run a process that CANNOT reach the network, for
 * that run only, without changing anything about the machine. This module is
 * that capability's contract, its honest self-test, and the one launcher every
 * policy-governed process goes through.
 *
 * Three rules shape the whole design, learned from the package-manager slices:
 *
 *  1. **Unknown or unsupported never becomes success.** A profile that asks for
 *     `deny_all` on a platform that cannot deliver it FAILS. It does not
 *     silently run an ordinary process — that is the exact shape of a security
 *     claim that is not true.
 *  2. **A disabled proxy is not denial**, and neither is a global firewall rule:
 *     both were measured and rejected in CL-11.4D-D. Enforcement must be
 *     per-run, unprivileged, and leave nothing behind after a crash.
 *  3. **The capability is MEASURED, not declared.** `probeIsolation` actually
 *     creates a namespace and actually tries to reach the network from inside a
 *     grandchild, because a platform that says it supports something and a
 *     platform that does are different platforms.
 */
import { createHash } from "node:crypto"

/** Bump when the profile SHAPE or its enforcement semantics change. */
export const ISOLATION_VERSION = 1

/** What a run is allowed to reach on the network. */
export type NetworkMode =
  /** No isolation applied — the child inherits the host's network. */
  | "inherit"
  /** No network at all: no external TCP/UDP, no DNS. */
  | "deny_all"
  /** Loopback only — reserved; NOT implemented in CL-16A. */
  | "loopback_only"

/**
 * What a caller ASKS for. A profile is a request, never a guarantee: the
 * guarantee comes from an `IsolationCapabilityReport` that says the platform can
 * actually deliver it.
 */
export interface ExecutionIsolationProfile {
  readonly network: NetworkMode
  /** The directory tree the run is scoped to. Enforcement is CL-06/CL-16B. */
  readonly filesystemScope?: string
  /** Environment keys the launcher must remove before spawning. */
  readonly stripEnv?: readonly string[]
  /** Environment the launcher must set, applied after stripping. */
  readonly envOverlay?: Readonly<Record<string, string>>
  /** Kill the whole descendant tree on cancel/timeout, not just the child. */
  readonly processTreeContainment: boolean
  /** Children must not be able to escape the parent's isolation. */
  readonly childInheritance: "required" | "best_effort"
  readonly isolationVersion: number
}

/** The profile CL-16A exists to deliver. */
export const DENY_ALL_PROFILE: ExecutionIsolationProfile = {
  network: "deny_all",
  processTreeContainment: true,
  childInheritance: "required",
  isolationVersion: ISOLATION_VERSION,
}

export type IsolationSupport = "supported" | "unsupported" | "unknown"

/**
 * What this machine can ACTUALLY enforce, established by running the mechanism
 * and observing the result — never by reading a platform name.
 */
export interface IsolationCapabilityReport {
  readonly platform: string
  /** The mechanism that was probed, e.g. `linux-userns-unshare`. */
  readonly mechanism: string
  readonly denyAll: IsolationSupport
  readonly processTree: IsolationSupport
  readonly childInheritance: IsolationSupport
  /** Whether loopback survives inside `deny_all`. Documented, not incidental. */
  readonly loopbackInsideDenyAll: "up" | "down" | "unknown"
  /**
   * CL-16A2-E — WHAT KIND OF EXECUTION the mechanism can isolate.
   *
   * `denyAll` alone conflates two different questions, and Windows separates
   * them. MEASURED inside a zero-capability AppContainer: `cmd.exe`,
   * `powershell.exe`, `python.exe`, `node.exe`, `git.exe` and `curl.exe` all run
   * and exit 0, while msys2's `bash.exe` cannot start at all — it exits
   * 0xC0000142 (STATUS_DLL_INIT_FAILED). That is NOT an ACL problem: the binary
   * already grants ALL APPLICATION PACKAGES (`0x1200a9;;;AC`). The msys runtime
   * simply cannot initialise without capabilities the container does not give.
   *
   * So the network isolation works and the RUNTIME COMPATIBILITY does not, and
   * a single `supported` flag would hide that. Absent is treated as `unknown`,
   * which is fail-closed: only an explicit `supported` permits the shape.
   */
  readonly nativeProcessIsolation?: IsolationSupport
  /** Generic POSIX-shell execution (`bash -c ...`). Separate from the above. */
  readonly shellRuntimeIsolation?: IsolationSupport
  /** True when the mechanism needs elevated privileges — disqualifying. */
  readonly requiresElevation: boolean
  /** True when the mechanism mutates machine-wide state — disqualifying. */
  readonly mutatesGlobalState: boolean
  readonly reasonCodes: readonly string[]
  /** Binds the report to a decision; re-checked before `tool.started`. */
  readonly evidenceHash: string
  readonly isolationVersion: number
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

function report(r: Omit<IsolationCapabilityReport, "evidenceHash" | "isolationVersion">): IsolationCapabilityReport {
  return {
    ...r,
    evidenceHash: sha256(JSON.stringify({ ...r, reasonCodes: [...r.reasonCodes].sort() })),
    isolationVersion: ISOLATION_VERSION,
  }
}

/** A tiny program that reports whether it can reach the network. */
const CANARY_PY = [
  "import socket,sys",
  "r={}",
  "try:",
  "    socket.setdefaulttimeout(4)",
  "    socket.getaddrinfo('example.com',80)",
  "    r['dns']='ok'",
  "except Exception as e: r['dns']='blocked:'+type(e).__name__",
  "try:",
  // 8.8.8.8:53 rather than 1.1.1.1: MEASURED, WSL2's NAT drops the latter even
  // with no isolation, and a canary the control cannot reach proves nothing.
  "    s=socket.create_connection(('8.8.8.8',53),timeout=4); s.close(); r['tcp']='ok'",
  "except Exception as e: r['tcp']='blocked:'+type(e).__name__",
  "try:",
  // sendto alone always 'succeeds' locally, so the reply is what is measured.
  "    u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); u.settimeout(3)",
  "    u.sendto(b'\\x00',('8.8.8.8',53)); u.recvfrom(64); u.close(); r['udp']='ok'",
  "except Exception as e: r['udp']='blocked:'+type(e).__name__",
  "try:",
  // A ROUND TRIP, not a bind. MEASURED 2026-07-26: `bind(('127.0.0.1',0))`
  // succeeds inside a fresh network namespace even though `lo` is DOWN, so the
  // probe reported loopback 'up' for a namespace where `ip addr show lo` says
  // DOWN and nothing can actually connect. Binding is not connectivity; the only
  // honest test of loopback is to listen and then reach the listener.
  "    l=socket.socket(); l.bind(('127.0.0.1',0)); l.listen(1)",
  "    c=socket.create_connection(l.getsockname(),timeout=3); c.close(); l.close(); r['loopback']='ok'",
  "except Exception as e: r['loopback']='blocked:'+type(e).__name__",
  "print(repr(r))",
].join("\n")

export interface CanaryResult {
  readonly dns: string
  readonly tcp: string
  readonly udp: string
  readonly loopback: string
  readonly exitCode: number | null
  readonly raw: string
}

const parseCanary = (raw: string, exitCode: number | null): CanaryResult => {
  const get = (k: string) => new RegExp(`'${k}':\\s*'([^']*)'`).exec(raw)?.[1] ?? "unknown"
  return { dns: get("dns"), tcp: get("tcp"), udp: get("udp"), loopback: get("loopback"), exitCode, raw: raw.trim() }
}

/** How a caller runs the canary — injected so tests can drive it directly. */
export type Spawner = (argv: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => { stdout: string; stderr: string; exitCode: number | null }

/** The default spawner. Fixed argv, no shell, no interpolation. */
export const defaultSpawner: Spawner = (argv, opts) => {
  // [CL-00A:ALLOW isolation_capability_probe]
  const p = Bun.spawnSync(argv as string[], {
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
    ...(opts?.env ? { env: opts.env } : {}),
  })
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), exitCode: p.exitCode }
}

/**
 * Wrap an argv so it runs with NO network, or return undefined when this
 * platform has no per-run mechanism.
 *
 * Linux: `unshare --user --map-root-user --net`. Unprivileged (it creates a user
 * namespace first), per-process, and it disappears with the process — nothing to
 * clean up, nothing left behind by a crash.
 *
 * Windows: nothing qualifies. A firewall rule needs elevation and mutates
 * machine-wide state; both were measured and rejected in CL-11.4D-D. Returning
 * undefined is the honest answer, and callers must treat it as unsupported
 * rather than falling back to an ordinary spawn.
 */
export function denyAllArgv(argv: readonly string[], platform: NodeJS.Platform = process.platform): readonly string[] | undefined {
  if (platform === "linux") return ["unshare", "--user", "--map-root-user", "--net", ...argv]
  return undefined
}

/**
 * Executables that ARE a generic POSIX shell runtime.
 *
 * Deliberately a short, explicit list rather than a heuristic. It exists only to
 * recognise the shape whose isolation is unsupported on a backend mechanism —
 * it never rewrites, translates or substitutes anything. A command written for
 * bash stays a command written for bash; if the mechanism cannot isolate that
 * runtime, the run is refused, not quietly executed by a different shell.
 */
const SHELL_RUNTIMES = new Set(["bash", "sh", "dash", "zsh", "bash.exe", "sh.exe", "dash.exe", "zsh.exe"])

export function isShellRuntimeExecutable(executable: string): boolean {
  const leaf = executable.split(/[\\/]/).pop()?.toLowerCase() ?? ""
  return SHELL_RUNTIMES.has(leaf)
}

/** Environment stripped from every isolated run: proxies are not policy, but a
 *  stale proxy inside a namespace only produces confusing failures. */
export const ISOLATION_STRIPPED_ENV = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const

export function isolationEnv(env: NodeJS.ProcessEnv, profile: ExecutionIsolationProfile): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of ISOLATION_STRIPPED_ENV) delete out[k]
  for (const k of profile.stripEnv ?? []) delete out[k]
  return { ...out, ...(profile.envOverlay ?? {}) }
}

/**
 * MEASURE what this platform can enforce. Runs the canary three ways — plain (a
 * control that must reach the network, or the whole probe is vacuous), isolated,
 * and isolated through a nested shell + grandchild — and reports only what was
 * observed.
 */
export function probeIsolation(opts: { python?: string; spawner?: Spawner; platform?: NodeJS.Platform } = {}): IsolationCapabilityReport {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawner ?? defaultSpawner
  const python = opts.python ?? (platform === "win32" ? "python" : "python3")
  const reasons: string[] = []

  const wrapped = denyAllArgv([python, "-c", CANARY_PY], platform)
  if (!wrapped) {
    // No per-run mechanism. Say so; do not improvise one.
    reasons.push(
      platform === "win32"
        ? "windows_no_per_run_network_isolation: this default probe has no per-run mechanism. CL-16A2-E built and proved a Windows AppContainer backend for NATIVE executables, but it is supplied by the host as an injected backend and is not advertised here; msys2 bash cannot run inside it (windows_appcontainer_shell_runtime_unsupported)"
        : `no_per_run_network_isolation_for_platform:${platform}`,
    )
    return report({
      platform, mechanism: "none", denyAll: "unsupported", processTree: "unknown",
      childInheritance: "unsupported", loopbackInsideDenyAll: "unknown",
      requiresElevation: false, mutatesGlobalState: false, reasonCodes: reasons,
    })
  }

  // CONTROL: without isolation the canary must reach the network. If it cannot,
  // this machine is simply offline and a "blocked" result below would prove
  // nothing at all.
  const control = parseCanary(...(() => { const r = spawn([python, "-c", CANARY_PY]); return [r.stdout + r.stderr, r.exitCode] as const })())
  const controlOnline = control.tcp === "ok" || control.dns === "ok"
  if (!controlOnline) reasons.push("control_offline_probe_inconclusive")

  const inside = parseCanary(...(() => { const r = spawn(wrapped); return [r.stdout + r.stderr, r.exitCode] as const })())
  if (inside.exitCode !== 0) reasons.push(`isolation_mechanism_failed:exit_${inside.exitCode}`)

  const blocked = (v: string) => v.startsWith("blocked:")

  // A protocol only counts toward the verdict if the CONTROL could use it.
  // Measured on WSL2: outbound UDP is dropped by the host NAT even without any
  // isolation, so demanding "UDP blocked inside" would credit the namespace for
  // something the network was already doing. Each protocol is judged only where
  // there was something to block.
  const judged = (["tcp", "dns", "udp"] as const).filter((k) => control[k] === "ok")
  for (const k of ["tcp", "dns", "udp"] as const) {
    if (control[k] !== "ok") reasons.push(`control_${k}_unavailable_not_judged`)
  }
  const allJudgedBlocked = judged.length > 0 && judged.every((k) => blocked(inside[k]))
  const denyAll: IsolationSupport =
    inside.exitCode !== 0 ? "unsupported"
      : !controlOnline || judged.length === 0 ? "unknown"
        : allJudgedBlocked ? "supported"
          : "unsupported"
  if (denyAll === "unsupported" && inside.exitCode === 0) {
    for (const k of judged) if (!blocked(inside[k])) reasons.push(`${k}_not_blocked`)
  }

  // A grandchild behind a nested shell must not regain the network.
  //
  // `sh -c 'exec "$0" "$@"' <python> -c <script>` passes the script as an ARGV
  // element instead of embedding it in the shell string. Embedding it needs
  // quoting that a multi-line program defeats, and a canary that fails to start
  // reads as "unknown" — which would quietly withdraw the inheritance claim
  // rather than test it.
  const nested = denyAllArgv(["sh", "-c", 'exec "$0" "$@"', python, "-c", CANARY_PY], platform)!
  const grand = parseCanary(...(() => { const r = spawn(nested); return [r.stdout + r.stderr, r.exitCode] as const })())
  const grandJudged = judged.filter((k) => k !== "udp")
  const childInheritance: IsolationSupport =
    grand.exitCode !== 0 || grandJudged.length === 0 ? "unknown"
      : grandJudged.every((k) => blocked(grand[k])) ? "supported" : "unsupported"
  if (childInheritance === "unsupported") reasons.push("child_escaped_isolation")

  return report({
    platform,
    mechanism: "linux-userns-unshare",
    denyAll,
    // Process-tree kill is the launcher's job and is exercised by its own tests.
    processTree: "supported",
    childInheritance,
    loopbackInsideDenyAll: inside.loopback === "ok" ? "up" : blocked(inside.loopback) ? "down" : "unknown",
    requiresElevation: false,
    mutatesGlobalState: false,
    reasonCodes: reasons,
  })
}

// --------------------------------------------------------------- the launcher
export interface IsolatedSpawnRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly profile: ExecutionIsolationProfile
  readonly capability: IsolationCapabilityReport
  /**
   * Names a mechanism that is NOT an argv wrapper (CL-16A2-E).
   *
   * Linux's `deny_all` is a prefix — `unshare ... <argv>` — so the plan can be a
   * pure argv transformation. Windows AppContainer is not: the container has to
   * be created, ACLs granted, the process made suspended, assigned to a job and
   * resumed, and all of it journalled. There is nothing to prepend.
   *
   * When this is set, the planner performs every capability check exactly as
   * before and then leaves the argv alone, because the isolation is delivered by
   * a backend the launcher drives rather than by a wrapper. The name is folded
   * into the plan hash, so a decision taken under one mechanism can never be
   * executed by another.
   */
  readonly backendMechanism?: string
}

export type IsolatedSpawnPlan =
  | { readonly ok: true; readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly applied: NetworkMode; readonly evidenceHash: string }
  | { readonly ok: false; readonly reasonCode: string; readonly detail: string }

/**
 * Turn a request into the exact argv/env that will be spawned, or REFUSE.
 *
 * This is deliberately a pure planner, not a spawner: the plan can be hashed
 * into the decision, re-checked before `tool.started`, and asserted in tests
 * without starting anything. The one rule it exists to enforce is that a
 * `deny_all` request on a platform reporting anything other than `supported`
 * produces a refusal — never an ordinary process.
 */
export function planIsolatedSpawn(req: IsolatedSpawnRequest): IsolatedSpawnPlan {
  if (req.profile.isolationVersion !== ISOLATION_VERSION) {
    return { ok: false, reasonCode: "isolation_version_mismatch", detail: `profile v${req.profile.isolationVersion} != v${ISOLATION_VERSION}` }
  }
  if (req.capability.isolationVersion !== ISOLATION_VERSION) {
    return { ok: false, reasonCode: "isolation_version_mismatch", detail: "capability report is from another isolation version" }
  }
  if (req.argv.length === 0) return { ok: false, reasonCode: "isolation_empty_argv", detail: "no program to run" }

  const env = isolationEnv(req.env, req.profile)

  if (req.profile.network === "inherit") {
    return { ok: true, argv: req.argv, env, cwd: req.cwd, applied: "inherit", evidenceHash: planHash(req, req.argv, "inherit") }
  }
  if (req.profile.network === "loopback_only") {
    // Reserved. Refusing beats approximating it with deny_all.
    return { ok: false, reasonCode: "isolation_mode_not_implemented", detail: "loopback_only is reserved for a later slice" }
  }

  // deny_all. Everything below is a refusal path; there is no fallback.
  if (req.capability.requiresElevation) {
    return { ok: false, reasonCode: "isolation_requires_elevation", detail: "a mechanism needing elevation is not an acceptable per-run control" }
  }
  if (req.capability.mutatesGlobalState) {
    return { ok: false, reasonCode: "isolation_mutates_global_state", detail: "a machine-wide change is not a per-run control" }
  }
  if (req.capability.denyAll !== "supported") {
    return { ok: false, reasonCode: "isolation_unsupported", detail: `deny_all is ${req.capability.denyAll} on ${req.capability.platform}: ${req.capability.reasonCodes.join(", ") || "no mechanism"}` }
  }
  if (req.profile.childInheritance === "required" && req.capability.childInheritance !== "supported") {
    return { ok: false, reasonCode: "isolation_child_inheritance_unproven", detail: `child inheritance is ${req.capability.childInheritance}` }
  }
  // RUNTIME COMPATIBILITY, which is a different question from network isolation.
  //
  // A backend mechanism may be able to contain the network perfectly and still
  // be unable to RUN a given kind of program. On Windows that is exactly the
  // case: native executables run inside the AppContainer, msys2 bash cannot
  // start in one. Refusing here means the refusal lands BEFORE the backend is
  // called and therefore before any profile or ACL is created — and it is a
  // refusal, never a fallback to an unisolated run.
  if (req.backendMechanism && isShellRuntimeExecutable(req.argv[0] ?? "") && req.capability.shellRuntimeIsolation !== "supported") {
    return {
      ok: false,
      reasonCode: "windows_appcontainer_shell_runtime_unsupported",
      detail:
        `the ${req.capability.mechanism} mechanism cannot isolate a generic shell runtime (${req.argv[0]}): ` +
        `shellRuntimeIsolation is ${req.capability.shellRuntimeIsolation ?? "unknown"}. Native executables are unaffected. ` +
        `Nothing was executed and no container was created.`,
    }
  }

  // A BACKEND-DELIVERED mechanism. Every gate above has already been applied;
  // what changes here is only that there is no wrapper to prepend.
  if (req.backendMechanism) {
    return { ok: true, argv: req.argv, env, cwd: req.cwd, applied: "deny_all", evidenceHash: planHash(req, req.argv, "deny_all") }
  }

  const wrapped = denyAllArgv(req.argv, req.capability.platform as NodeJS.Platform)
  if (!wrapped) return { ok: false, reasonCode: "isolation_unsupported", detail: `no deny_all mechanism on ${req.capability.platform}` }

  return { ok: true, argv: wrapped, env, cwd: req.cwd, applied: "deny_all", evidenceHash: planHash(req, wrapped, "deny_all") }
}

function planHash(req: IsolatedSpawnRequest, argv: readonly string[], applied: NetworkMode): string {
  return sha256(JSON.stringify({
    kind: "isolation-plan",
    isolationVersion: ISOLATION_VERSION,
    applied,
    argv,
    cwd: req.cwd,
    // Names only — an environment VALUE can be a secret.
    envKeys: Object.keys(req.env).sort(),
    overlayKeys: Object.keys(req.profile.envOverlay ?? {}).sort(),
    stripped: [...ISOLATION_STRIPPED_ENV, ...(req.profile.stripEnv ?? [])].sort(),
    profile: { network: req.profile.network, tree: req.profile.processTreeContainment, child: req.profile.childInheritance },
    // The mechanism is part of the plan's identity: an AppContainer decision must
    // not be executable by an unshare wrapper, or the reverse.
    backendMechanism: req.backendMechanism ?? null,
    capability: req.capability.evidenceHash,
  }))
}
