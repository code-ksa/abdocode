/**
 * CL-16A2-B — the ONE controlled process launcher.
 *
 * Before this module every policy-governed process was started by an ad-hoc
 * `Bun.spawn` inside the tool that wanted it. The decision said one thing and
 * the spawn did another, and nothing checked that they still agreed.
 *
 * `launchControlledProcess` is the single place a governed process starts. It is
 * not a helper the real shell may choose to use — the CL-00A guard allows the
 * `process execution` primitive in this file and forbids it in the tools, so the
 * shell CANNOT spawn any other way.
 *
 * Four rules, each learned the hard way:
 *
 *  1. **The environment is EXPLICIT.** MEASURED on Bun 1.3.14: mutating
 *     `process.env` after startup does NOT reach a child — Bun captures the
 *     environment once and only an explicit `env:` overrides it. So the caller
 *     builds the final child environment and this launcher always passes it.
 *     There is no code path here that lets a child inherit an environment nobody
 *     wrote down. `launcher-env.test.ts` proves the child's PATH is the one in
 *     `env`, not the one in `process.env`.
 *  2. **Isolation is applied or the launch is REFUSED.** `deny_all` on a
 *     platform whose capability report is anything other than `supported`
 *     returns a refusal BEFORE the spawn. It never degrades to an ordinary
 *     process, because a record claiming a protection nothing enforced is worse
 *     than a denial.
 *  3. **The proof is durable before the effect.** `isolation.requested`,
 *     `isolation.capability_checked` and `isolation.applied` are awaited before
 *     `Bun.spawn` is reached. A crash between the record and the spawn leaves an
 *     applied-with-no-result — the safe direction. The opposite order would let
 *     a process run with no isolation record at all.
 *  4. **Nothing is trusted across the gap.** Everything the decision rested on —
 *     the command, the cwd, the environment's KEY NAMES, the profile, the
 *     platform capability, the isolation primitive on disk, this launcher's own
 *     version — is re-derived immediately before the spawn and compared with
 *     what was durably recorded. A change refuses: `stale_isolation_evidence`
 *     on the automatic path, `approval_snapshot_stale` when a human approved.
 *
 * NEVER RECORDED: an environment VALUE. Events carry key NAMES only. A token in
 * an audit log is a leak that outlives the run.
 */
import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { deriveExecutionDialect, type ExecutionDialect } from "./dialect"
import { validateAclPlan, type AclGrantRequest } from "./windows-acl-matrix"
import {
  ISOLATION_STRIPPED_ENV,
  ISOLATION_VERSION,
  isolationEnv,
  planIsolatedSpawn,
  type ExecutionIsolationProfile,
  type IsolationCapabilityReport,
  type NetworkMode,
} from "./isolation"
import { stripChildEnv } from "./env-strip"

/** Bump when the launcher's ENFORCEMENT semantics change, not on refactors. */
export const LAUNCHER_VERSION = 1

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/**
 * Where an isolation primitive may live. Deliberately NOT `PATH`: the primitive
 * that enforces the isolation must not itself be resolvable through a directory
 * the run can influence. (CL-11.5A measured a real instance of this shape on
 * Windows — `link.exe` resolved to Git's coreutils instead of MSVC purely
 * because of PATH order.)
 */
export const TRUSTED_PRIMITIVE_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/usr/sbin", "/sbin"] as const

/**
 * This launcher's behavioural identity. It hashes the things that decide what a
 * child actually gets — not the file's bytes, which change on every comment
 * edit. If the deny-all mechanism, the stripped-environment list or the trusted
 * primitive locations change, this hash changes and every decision taken under
 * the old one goes stale.
 */
export const LAUNCHER_HASH = sha256(
  JSON.stringify({
    launcherVersion: LAUNCHER_VERSION,
    isolationVersion: ISOLATION_VERSION,
    strippedEnv: [...ISOLATION_STRIPPED_ENV],
    trustedPrimitiveDirs: [...TRUSTED_PRIMITIVE_DIRS],
    denyAllPrimitive: "unshare --user --map-root-user --net",
  }),
)

// ---------------------------------------------------------------- durable events

export const IsolationEventTypes = {
  Requested: "isolation.requested",
  CapabilityChecked: "isolation.capability_checked",
  Applied: "isolation.applied",
  Failed: "isolation.failed",
} as const

export type IsolationEventType = (typeof IsolationEventTypes)[keyof typeof IsolationEventTypes]

/**
 * One durable isolation record. Versioned, so a replay can tell which
 * enforcement semantics produced it.
 *
 * SECRET DISCIPLINE: `envConstraintNames` holds NAMES. There is no field on this
 * type that can carry an environment value, a token or a credential, and
 * `launcher-events.test.ts` asserts that no emitted event ever contains one.
 */
export interface IsolationEvent {
  readonly type: IsolationEventType
  readonly isolationVersion: number
  readonly launcherVersion: number
  readonly launcherHash: string
  readonly requestedMode: NetworkMode
  readonly appliedMode?: NetworkMode
  readonly platform: string
  /** The isolation primitive's absolute path — "" when none is needed. */
  readonly primitive?: string
  /** dev:ino:size:mode of the primitive, or "absent". Binds it across the gap. */
  readonly primitiveIdentity?: string
  readonly capabilityEvidenceHash: string
  readonly isolationProfileHash: string
  /** sha256 over executable + argv. The command, without quoting it into prose. */
  readonly commandHash: string
  /** The resolved (realpath) working directory. */
  readonly cwd: string
  /** Environment KEY NAMES only — never values. */
  readonly envConstraintNames?: readonly string[]
  readonly failureReason?: string
  readonly detail?: string
  readonly decisionId?: string
  readonly executionId?: string
  /**
   * CL-16A3 — the derived execution dialect. HOST-DERIVED, never model-supplied,
   * and part of the fingerprint below, so swapping the shape of an execution
   * between the decision and the spawn is drift like any other element.
   */
  readonly dialect?: ExecutionDialect
}

export type IsolationEventSink = (event: IsolationEvent) => Promise<void> | void

// ---------------------------------------------------------- isolation backends

/**
 * CL-16A2-E — how an isolation mechanism that is NOT an argv wrapper runs.
 *
 * Linux `deny_all` is a prefix, so the launcher can plan it and spawn it itself.
 * Windows AppContainer cannot work that way: a container has to be created, ACLs
 * granted under a lease, the process created SUSPENDED, assigned to a job,
 * resumed, and every step journalled so a crash is recoverable. That is a
 * lifecycle, not a wrapper.
 *
 * It is delivered as an injected backend rather than a second launcher, which is
 * the whole point: `launchControlledProcess` still owns the durable records, the
 * capability gate, the TOCTOU re-check and the refusal semantics. There is no
 * path to an AppContainer that does not pass through this function, so there is
 * no path that bypasses the enforcement point.
 */
export interface IsolationBackendRequest {
  /** Deterministic per execution. The backend derives resource names from it. */
  readonly runId: string
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  /** The COMPLETE child environment, already stripped and overlaid. */
  readonly env: Readonly<Record<string, string>>
  readonly profile: ExecutionIsolationProfile
  readonly timeoutMs: number
  readonly cancellation?: AbortSignal
}

export interface IsolationBackendResult {
  readonly ok: boolean
  readonly reasonCode?: string
  readonly detail?: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  /**
   * PROOF that a child process really started.
   *
   * A sandbox that appears to run commands and runs none is indistinguishable
   * from a perfect sandbox if you only check that the network was unreachable —
   * that exact failure (`DETACHED_PROCESS`, exit 0, nothing executed) is why the
   * measurement harness was rebuilt. A backend that cannot say a child started
   * does not get to report a result.
   */
  readonly childStarted: boolean
  /**
   * What the backend OBSERVED itself achieve. `isolation.applied` is written
   * only when every one of these is true, so the record is a statement about the
   * machine rather than about having reached a line of code.
   */
  readonly appliedEvidence?: {
    readonly profileCreated: boolean
    readonly profileOwnedByRun: boolean
    readonly aclApplied: boolean
    readonly childCreatedInContainer: boolean
    readonly assignedToJob: boolean
    readonly resumed: boolean
  }
}

export interface IsolationBackend {
  /** Stable mechanism name; folded into the plan hash and the TOCTOU check. */
  readonly mechanism: string
  run(req: IsolationBackendRequest): Promise<IsolationBackendResult>
}

// ------------------------------------------------------------------- the grant

/**
 * What the ENFORCEMENT POINT hands a tool so it may start a process. The model
 * cannot produce one: it is built by `PolicyToolRunner` from the decision and
 * reaches the tool through `ToolContext.execution`, never through tool
 * arguments. A tool that receives no grant runs under `inherit` — the behaviour
 * that already existed — and can never obtain `deny_all` on its own.
 */
export interface ControlledExecutionGrant {
  readonly profile: ExecutionIsolationProfile
  readonly capability: IsolationCapabilityReport
  /** True when a HUMAN approved this call; changes which staleness code applies. */
  readonly approvalGranted: boolean
  /**
   * The evidence hash the approval (or the automatic allow) was given against.
   * Re-read just before the spawn; a change means the human approved a snapshot
   * that no longer exists.
   */
  readonly approvalEvidenceHash?: string
  /** Names of the environment keys the decision's constraints impose. */
  readonly envConstraintNames?: readonly string[]
  readonly decisionId?: string
  readonly executionId?: string
  /** Durable sink. If it throws, the launch FAILS CLOSED — nothing spawns. */
  readonly emit?: IsolationEventSink
  /**
   * The ACL grants this execution needs, expressed in the MATRIX's vocabulary.
   *
   * Validated host-side before any durable intent or OS mutation: an operation,
   * target or right the matrix does not know is refused outright rather than
   * forwarded, because passing it on would ask the OS to interpret a value no
   * measurement stands behind, and a typo would become a silently different
   * grant.
   */
  readonly aclPlan?: readonly AclGrantRequest[]
  /**
   * The mechanism for modes this platform cannot deliver with an argv wrapper.
   * Supplied by the ENFORCEMENT POINT, never by a tool and never by the model.
   * Absent means the launcher plans and spawns the process itself.
   */
  readonly backend?: IsolationBackend
}

/** The profile a tool runs under when the control plane imposed none. */
export const INHERIT_PROFILE: ExecutionIsolationProfile = {
  network: "inherit",
  processTreeContainment: true,
  childInheritance: "best_effort",
  isolationVersion: ISOLATION_VERSION,
}

/**
 * The capability report used when the host measured NONE. Every mode except
 * `inherit` is `unknown` here, so a `deny_all` request that reaches the launcher
 * without a measurement is REFUSED by `planIsolatedSpawn` rather than run
 * unisolated. Fail-closed by construction: there is no branch to forget.
 */
export const UNMEASURED_CAPABILITY: IsolationCapabilityReport = {
  platform: process.platform,
  mechanism: "unmeasured",
  denyAll: "unknown",
  processTree: "unknown",
  childInheritance: "unknown",
  loopbackInsideDenyAll: "unknown",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: ["isolation_capability_unmeasured: the host did not run probeIsolation, so nothing beyond `inherit` can be granted"],
  evidenceHash: sha256("unmeasured-isolation-capability"),
  isolationVersion: ISOLATION_VERSION,
}

export function profileHash(p: ExecutionIsolationProfile): string {
  return sha256(
    JSON.stringify({
      network: p.network,
      filesystemScope: p.filesystemScope ?? null,
      stripEnv: [...(p.stripEnv ?? [])].sort(),
      // Overlay KEYS only. The values are exactly the kind of thing that must
      // not end up in a hash we print next to a log line.
      envOverlayKeys: Object.keys(p.envOverlay ?? {}).sort(),
      processTreeContainment: p.processTreeContainment,
      childInheritance: p.childInheritance,
      isolationVersion: p.isolationVersion,
    }),
  )
}

// -------------------------------------------------------------- test seams

/**
 * Seams that let a test change EACH element between the durable decision record
 * and the spawn. They are how §5's TOCTOU checks are proven to fire rather than
 * merely written down.
 *
 * `driftForTest` is deliberately powerful: it changes what WOULD be spawned, so
 * a test that drifts the cwd and asserts a refusal is a real test — with the
 * guard removed, that drifted cwd is where the process would actually run. The
 * launcher-toctou suite includes exactly that control.
 */
export interface LauncherHooks {
  readonly realpath?: (p: string) => string
  readonly primitiveIdentity?: (path: string) => string
  readonly resolvePrimitive?: (name: string) => string | undefined
  readonly capabilityNow?: () => IsolationCapabilityReport
  readonly launcherIdentityNow?: () => { version: number; hash: string }
  readonly approvalEvidenceNow?: () => string | undefined
  /**
   * The mechanism as it stands just before the spawn. Every other element the
   * decision rested on has a seam like this; without one, swapping the isolation
   * MECHANISM between the decision and the execution would be the only kind of
   * drift the TOCTOU check could not be shown to catch.
   */
  readonly backendMechanismNow?: () => string
  /** The dialect as it stands just before the spawn — the §10 TOCTOU seam. */
  readonly dialectNow?: () => ExecutionDialect
  /** Applied in the window between `isolation.requested` and the pre-spawn check. */
  readonly driftForTest?: () => Partial<Pick<ControlledLaunchRequest, "executable" | "argv" | "cwd" | "env" | "isolationProfile">>
  /** Skips the pre-spawn comparison. ONLY for the control that proves drift is real. */
  readonly disableToctouForTest?: boolean
  // [CL-00A:ALLOW controlled_process_launcher]
  readonly spawn?: typeof Bun.spawn
}

// ----------------------------------------------------------------- the request

export interface ControlledLaunchRequest {
  /** The program. Never a shell string: no interpolation happens in here. */
  readonly executable: string
  /** Arguments AFTER the executable, already separated. */
  readonly argv: readonly string[]
  /** A directory that already exists; it is realpath'd and pinned. */
  readonly cwd: string
  /**
   * The COMPLETE child environment. Not a patch, not a delta — what the child
   * gets. Bun captured `process.env` at startup and will not re-read it.
   */
  readonly env: Readonly<Record<string, string>>
  readonly isolationProfile: ExecutionIsolationProfile
  readonly capability: IsolationCapabilityReport
  readonly cancellation?: AbortSignal
  readonly timeoutMs: number
  readonly evidence: ControlledExecutionGrant
  readonly hooks?: LauncherHooks
  /**
   * بثُّ الخرج قطعةً قطعة أثناء التنفيذ. غيابُه = السلوكُ القديم حرفياً:
   * يُجمَّع النصُّ ويُعاد بعد الخروج، ولا يُنادى أحد.
   *
   * **ليس قناةً ثانيةً للنتيجة**: العائدُ يبقى النصَّ الكامل كما كان، وهذا
   * إشعارٌ بالتقدّم فقط. من بنى على العائد لا يتغيّر عنده شيء.
   */
  readonly onOutput?: (chunk: { readonly stream: "stdout" | "stderr"; readonly text: string }) => void
}

export type ControlledLaunchResult =
  | {
      readonly outcome: "ran"
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
      readonly timedOut: boolean
      readonly aborted: boolean
      readonly durationMs: number
      readonly appliedMode: NetworkMode
      /** The exact argv that was spawned, primitive wrapper included. */
      readonly spawnedArgv: readonly string[]
    }
  | {
      readonly outcome: "refused"
      /** Machine-readable; the caller turns it into a message, never a guess. */
      readonly reasonCode: string
      readonly detail: string
      readonly durationMs: number
    }
  | {
      readonly outcome: "spawn_failed"
      readonly reasonCode: "process_spawn_failed"
      readonly detail: string
      readonly durationMs: number
      readonly appliedMode: NetworkMode
    }

// ------------------------------------------------------------------ primitives

const defaultIdentity = (path: string): string => {
  try {
    const s = statSync(path)
    return `${s.dev}:${s.ino}:${s.size}:${s.mode}`
  } catch {
    return "absent"
  }
}

/**
 * Find the deny-all primitive in a TRUSTED location. Returns undefined when it
 * is not there — which is a refusal, never a fallback to running unisolated.
 */
export function resolveIsolationPrimitive(name: string): string | undefined {
  for (const dir of TRUSTED_PRIMITIVE_DIRS) {
    const candidate = `${dir}/${name}`
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not here */
    }
  }
  return undefined
}

// ------------------------------------------------------------- process control

/** Kill the whole descendant tree, not just the direct child. */
export function killProcessTree(proc: { pid: number; kill: (code?: number) => void }): void {
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
  try {
    if (process.platform === "win32") {
      // [CL-00A:ALLOW controlled_process_launcher]
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL") // negative pid => the process GROUP
      } catch {
        proc.kill(9)
      }
    }
  } catch {
    /* process already gone */
  }
}

// ---------------------------------------------------------------- the launcher

interface Fingerprint {
  readonly commandHash: string
  readonly cwd: string
  readonly envNames: readonly string[]
  readonly profileHash: string
  readonly capabilityEvidenceHash: string
  readonly platform: string
  readonly primitive: string
  readonly primitiveIdentity: string
  readonly launcherVersion: number
  readonly launcherHash: string
  readonly approvalEvidenceHash: string
  /** Which mechanism will deliver the isolation. Swapping it is drift. */
  readonly backendMechanism: string
  /** The derived execution dialect. Swapping the shape is drift too. */
  readonly dialect: ExecutionDialect
}

/** Everything the decision rested on, re-derivable at any instant. */
function fingerprintOf(
  spec: Pick<ControlledLaunchRequest, "executable" | "argv" | "cwd" | "env" | "isolationProfile">,
  capability: IsolationCapabilityReport,
  approvalEvidenceHash: string | undefined,
  hooks: LauncherHooks | undefined,
  backendMechanism = "",
): Fingerprint {
  const realpath = hooks?.realpath ?? ((p: string) => realpathSync(p))
  const identityOf = hooks?.primitiveIdentity ?? defaultIdentity
  const resolve = hooks?.resolvePrimitive ?? resolveIsolationPrimitive
  const ident = hooks?.launcherIdentityNow?.() ?? { version: LAUNCHER_VERSION, hash: LAUNCHER_HASH }

  let cwdReal: string
  try {
    cwdReal = realpath(spec.cwd)
  } catch {
    cwdReal = `<unresolvable:${spec.cwd}>`
  }
  const primitive = spec.isolationProfile.network === "deny_all" ? (resolve("unshare") ?? "") : ""
  return {
    commandHash: sha256(JSON.stringify({ executable: spec.executable, argv: [...spec.argv] })),
    cwd: cwdReal,
    // NAMES only. Sorted so an insertion-order change is not a false alarm.
    envNames: Object.keys(spec.env).sort(),
    profileHash: profileHash(spec.isolationProfile),
    capabilityEvidenceHash: capability.evidenceHash,
    platform: capability.platform,
    primitive,
    primitiveIdentity: primitive ? identityOf(primitive) : "n/a",
    launcherVersion: ident.version,
    launcherHash: ident.hash,
    approvalEvidenceHash: approvalEvidenceHash ?? "",
    backendMechanism,
    // Derived from the SPEC that will actually run, so a drifted executable or
    // argv changes the dialect as well as the command hash.
    dialect: hooks?.dialectNow?.() ?? deriveExecutionDialect(spec.executable, spec.argv).dialect,
  }
}

/** Which fields moved between the record and the spawn. Names, never values. */
function drifted(before: Fingerprint, after: Fingerprint): string[] {
  const out: string[] = []
  for (const k of Object.keys(before) as (keyof Fingerprint)[]) {
    const a = before[k]
    const b = after[k]
    const same = Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b
    if (!same) out.push(k)
  }
  return out
}

/**
 * Start a governed process — or refuse before starting one.
 *
 * Returns `refused` with a reason code whenever the isolation the decision
 * assumed cannot be delivered, or when anything the decision rested on moved.
 * `ran` means the process actually started; a non-zero `exitCode` is a normal
 * `ran` outcome, not a launcher failure.
 */
/**
 * استنزافُ أنبوبٍ **قطعةً قطعة** مع تجميعِ النصّ كاملاً.
 *
 * كان هذا `new Response(stream).text()` — يجمع كلَّ شيءٍ ثمّ يعيده دفعةً بعد
 * خروج العملية. فما تراه القشرةُ «بثّاً» كان إعادةَ عرضٍ لنصٍّ اكتمل: دوّارةٌ
 * تدور بلا سبيلٍ إلى تمييز بناءٍ بطيءٍ من أمرٍ معلّق.
 *
 * **الفخُّ الذي يجعل التنفيذَ الساذج يفسد العربيّة**: الحرفُ العربيُّ بايتان
 * في UTF-8، والقطعةُ تنقطع حيث تشاء — فقد تصل نصفَ حرف. `TextDecoder` بلا
 * `stream: true` يستبدل النصفَ بـ«�» فتُشوَّه الكلمة، ويبقى النصُّ المجمَّع
 * مختلفاً عمّا كان يعيده `.text()`. الحالةُ المحفوظةُ بين النداءات هي ما
 * يمنع ذلك، والذيلُ يُصرَّف بنداءٍ أخير بلا وسيط.
 *
 * والعائدُ يبقى **النصَّ الكامل بايتاً** كما كان — البثُّ إضافةٌ لا استبدال،
 * فكلُّ ما يقرأ الخرجَ اليوم لا يتغيّر عنده شيء.
 */
export async function drainStream(stream: ReadableStream, onChunk?: (text: string) => void): Promise<string> {
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder("utf-8")
  let whole = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const piece = decoder.decode(value, { stream: true })
      if (piece.length > 0) { whole += piece; onChunk?.(piece) }
    }
  } finally {
    reader.releaseLock()
  }
  // ذيلُ الحالة: حرفٌ بقي نصفُه معلّقاً عند نهاية المجرى يُصرَّف هنا.
  const tail = decoder.decode()
  if (tail.length > 0) { whole += tail; onChunk?.(tail) }
  return whole
}

export async function launchControlledProcess(req: ControlledLaunchRequest): Promise<ControlledLaunchResult> {
  const t0 = Date.now()
  const hooks = req.hooks
  const emit = req.evidence.emit
  const requestedMode = req.isolationProfile.network

  // A spec the drift hook can replace, so a test can move any element inside the
  // window this function's own durable writes create.
  let spec: Pick<ControlledLaunchRequest, "executable" | "argv" | "cwd" | "env" | "isolationProfile"> = {
    executable: req.executable,
    argv: req.argv,
    cwd: req.cwd,
    env: req.env,
    isolationProfile: req.isolationProfile,
  }

  const capabilityAtRequest = req.capability
  const approvalAtRequest = req.evidence.approvalEvidenceHash

  // WHICH MECHANISM WILL DELIVER THIS? Decided once, recorded, and re-checked
  // before the spawn like everything else. A backend is only consulted for a
  // mode that needs one: `inherit` keeps the existing path untouched, which is
  // what stops this slice from changing behaviour it was not asked to change.
  const backend = requestedMode === "deny_all" ? req.evidence.backend : undefined
  const backendMechanism = backend?.mechanism ?? ""

  const atRequest = fingerprintOf(spec, capabilityAtRequest, approvalAtRequest, hooks, backendMechanism)

  const baseEvent = (type: IsolationEventType, fp: Fingerprint, extra: Partial<IsolationEvent> = {}): IsolationEvent => ({
    type,
    isolationVersion: ISOLATION_VERSION,
    launcherVersion: fp.launcherVersion,
    launcherHash: fp.launcherHash,
    requestedMode,
    platform: fp.platform,
    primitive: fp.primitive,
    primitiveIdentity: fp.primitiveIdentity,
    capabilityEvidenceHash: fp.capabilityEvidenceHash,
    isolationProfileHash: fp.profileHash,
    commandHash: fp.commandHash,
    cwd: fp.cwd,
    dialect: fp.dialect,
    ...(req.evidence.envConstraintNames?.length ? { envConstraintNames: [...req.evidence.envConstraintNames].sort() } : {}),
    ...(req.evidence.decisionId ? { decisionId: req.evidence.decisionId } : {}),
    ...(req.evidence.executionId ? { executionId: req.evidence.executionId } : {}),
    ...extra,
  })

  /** Durable or nothing runs. A sink that throws is a refusal, not a warning. */
  const record = async (e: IsolationEvent): Promise<string | undefined> => {
    if (!emit) return undefined
    try {
      await emit(e)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  const refuse = (reasonCode: string, detail: string): ControlledLaunchResult => ({
    outcome: "refused",
    reasonCode,
    detail,
    durationMs: Date.now() - t0,
  })

  // 0. THE ACL PLAN IS VALIDATED FIRST — before the journal, before the
  //    capability check, before the backend exists as a possibility. A plan
  //    naming something the matrix does not know never becomes a durable intent.
  if (req.evidence.aclPlan?.length) {
    const verdict = validateAclPlan(req.evidence.aclPlan)
    if (!verdict.ok) return refuse(verdict.reasonCode, verdict.detail)
  }

  // 1. WHAT WAS ASKED FOR — durable before anything is checked or started.
  const e1 = await record(baseEvent(IsolationEventTypes.Requested, atRequest))
  if (e1) return refuse("isolation_evidence_not_recorded", `the isolation record could not be persisted: ${e1}`)

  // 2. WHAT THE PLATFORM CAN ACTUALLY DELIVER.
  const capability = hooks?.capabilityNow?.() ?? capabilityAtRequest
  const e2 = await record(
    baseEvent(IsolationEventTypes.CapabilityChecked, fingerprintOf(spec, capability, approvalAtRequest, hooks, backendMechanism), {
      detail: `denyAll=${capability.denyAll} childInheritance=${capability.childInheritance} mechanism=${capability.mechanism}`,
    }),
  )
  if (e2) return refuse("isolation_evidence_not_recorded", `the capability record could not be persisted: ${e2}`)

  // 3. DRIFT WINDOW. Everything above performed awaited durable writes — real
  //    I/O, real elapsed time. This is where a test moves an element, and where
  //    reality can move one too.
  //
  //    THE ORDER MATTERS AND WAS WRONG ONCE: the spawn plan used to be built
  //    BEFORE this point, so a drifted argv was detected by the check but could
  //    never have reached the spawn anyway — the check was decorative. The
  //    control in `launcher-toctou.test.ts` caught that. Everything that decides
  //    what actually runs is now derived from the post-drift spec, which is what
  //    makes the comparison below load-bearing.
  if (hooks?.driftForTest) spec = { ...spec, ...hooks.driftForTest() }

  // 4. TOCTOU. Re-derive and compare. Nothing starts on a mismatch.
  const capabilityNow = hooks?.capabilityNow?.() ?? capability
  const approvalNow = hooks?.approvalEvidenceNow ? hooks.approvalEvidenceNow() : approvalAtRequest
  const mechanismNow = hooks?.backendMechanismNow?.() ?? backendMechanism
  const atSpawn = fingerprintOf(spec, capabilityNow, approvalNow, hooks, mechanismNow)
  const moved = hooks?.disableToctouForTest ? [] : drifted(atRequest, atSpawn)
  if (moved.length > 0) {
    const reasonCode = req.evidence.approvalGranted ? "approval_snapshot_stale" : "stale_isolation_evidence"
    const detail = req.evidence.approvalGranted
      ? `changed after the human approved it: ${moved.join(", ")}; a fresh approval is required and nothing was executed`
      : `changed between the decision and the spawn: ${moved.join(", ")}; nothing was executed`
    await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: reasonCode, detail }))
    return refuse(reasonCode, detail)
  }

  // 5. PLAN OR REFUSE, from the spec that survived the check. `planIsolatedSpawn`
  //    is pure and never spawns; a request for isolation this platform cannot
  //    deliver dies HERE, before any process exists.
  const plan = planIsolatedSpawn({
    argv: [spec.executable, ...spec.argv],
    cwd: spec.cwd,
    env: spec.env as NodeJS.ProcessEnv,
    profile: spec.isolationProfile,
    capability: capabilityNow,
    ...(backendMechanism ? { backendMechanism } : {}),
  })
  if (!plan.ok) {
    await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: plan.reasonCode, detail: plan.detail }))
    return refuse(plan.reasonCode, plan.detail)
  }

  // 5b. The primitive must be present in a TRUSTED directory, and the argv that
  //     actually runs uses its ABSOLUTE path — not the bare name `PATH` resolves.
  let finalArgv = [...plan.argv]
  if (plan.applied === "deny_all" && !backend) {
    const primitive = (hooks?.resolvePrimitive ?? resolveIsolationPrimitive)("unshare")
    if (!primitive) {
      await record(
        baseEvent(IsolationEventTypes.Failed, atSpawn, {
          failureReason: "isolation_primitive_missing",
          detail: `no 'unshare' in a trusted location (${TRUSTED_PRIMITIVE_DIRS.join(", ")})`,
        }),
      )
      return refuse("isolation_primitive_missing", `deny_all needs 'unshare' in ${TRUSTED_PRIMITIVE_DIRS.join(", ")}; it is not there`)
    }
    finalArgv = [primitive, ...finalArgv.slice(1)]
  }

  // 6. THE PROOF LANDS BEFORE THE EFFECT — for the mechanisms THIS function
  //    applies itself.
  //
  //    For a wrapper (Linux `unshare`) the isolation is established by the very
  //    spawn on the next line, so recording first is the safe direction: a crash
  //    in between leaves an applied-with-no-result, never a run with no record.
  //
  //    A BACKEND IS DIFFERENT AND THE ORDER WAS WRONG. The backend performs the
  //    OS effects itself — creating the container, granting ACLs, starting the
  //    process suspended, assigning the job, resuming it — so writing `applied`
  //    beforehand claims a protection that does not exist yet, and would still
  //    claim it if every one of those steps then failed. The backend's own
  //    durable lifecycle intent is what covers the gap (that is what makes its
  //    work recoverable); `isolation.applied` is written afterwards, from
  //    OBSERVED evidence, or not at all.
  if (!backend) {
    const applied = baseEvent(IsolationEventTypes.Applied, atSpawn, { appliedMode: plan.applied })
    const e3 = await record(applied)
    if (e3) return refuse("isolation_evidence_not_recorded", `the applied-isolation record could not be persisted: ${e3}`)
  }

  // 7. SPAWN. The environment is passed EXPLICITLY, always — Bun will not re-read
  //    `process.env`, so anything not in here does not reach the child.
  // الطبقةُ الثانية للتجريد — **آخرُ نقطةٍ قبل ولادة العملية**، ويمرّ منها
  // الطريقان (الخلفيّةُ المعزولة والتشغيلُ المباشر). العقدُ أعلاه يقول إنّ
  // المُنادي يسلّم بيئةً «مجرّدةً بالفعل»، والمقيس (2026-09-04) أنّ أربعةَ
  // مواضعَ في المنتَج لم تكن تجرّد أصلاً. عقدٌ يعتمد على تذكُّرِ المُنادي ليس
  // حارساً. والتجريدُ متحايد، فالطبقتان لا تتنازعان.
  //
  // وهي **بعد** `driftForTest`: حارسٌ يسبق نقطةَ الانحراف يُلتفّ عليه.
  const childEnv = stripChildEnv(
    isolationEnv(spec.env as NodeJS.ProcessEnv, spec.isolationProfile) as Record<string, string>,
  ).env

  // 7a. A BACKEND-DELIVERED MECHANISM runs here, under the records already
  //     written above. It is not an alternative to this function; it is the part
  //     of this function that differs when the isolation is a lifecycle rather
  //     than a wrapper.
  if (backend) {
    // The run id is DERIVED, never supplied by a tool or the model, because the
    // backend derives resource names (the AppContainer profile) from it.
    const runId = req.evidence.executionId ?? sha256(`${atSpawn.commandHash}:${atSpawn.cwd}:${t0}`).slice(0, 32)
    let r: IsolationBackendResult
    try {
      r = await backend.run({
        runId,
        executable: spec.executable,
        argv: spec.argv,
        cwd: atSpawn.cwd,
        env: childEnv,
        profile: spec.isolationProfile,
        timeoutMs: req.timeoutMs,
        ...(req.cancellation ? { cancellation: req.cancellation } : {}),
      })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: "isolation_backend_failed", detail }))
      return refuse("isolation_backend_failed", detail)
    }
    if (!r.ok) {
      const reasonCode = r.reasonCode ?? "isolation_backend_failed"
      const detail = r.detail ?? "the isolation backend refused"
      await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: reasonCode, detail }))
      return refuse(reasonCode, detail)
    }
    // A RESULT WITHOUT A CHILD IS NOT A RESULT. `exit 0` with nothing executed
    // looks exactly like a perfect sandbox; it is the single most dangerous
    // outcome this whole line of work exists to prevent, so it fails loudly
    // rather than being reported as a successful isolated run.
    if (!r.childStarted) {
      const detail = "the backend returned a result with no child_started: the command did not run"
      await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: "isolation_child_never_started", detail }))
      return refuse("isolation_child_never_started", detail)
    }
    // EVERY STAGE MUST BE OBSERVED before the isolation is called applied.
    const ev = r.appliedEvidence
    const missing = !ev
      ? ["appliedEvidence"]
      : Object.entries(ev)
          .filter(([, v]) => v !== true)
          .map(([k]) => k)
    if (missing.length > 0) {
      const detail = `the backend could not show the isolation was established: ${missing.join(", ")}`
      await record(baseEvent(IsolationEventTypes.Failed, atSpawn, { failureReason: "isolation_not_established", detail }))
      return refuse("isolation_not_established", detail)
    }
    // NOW it is true, and only now is it recorded.
    const e3b = await record(baseEvent(IsolationEventTypes.Applied, atSpawn, { appliedMode: plan.applied }))
    if (e3b) return refuse("isolation_evidence_not_recorded", `the applied-isolation record could not be persisted: ${e3b}`)
    return {
      outcome: "ran",
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      aborted: r.aborted,
      durationMs: Date.now() - t0,
      appliedMode: plan.applied,
      spawnedArgv: [spec.executable, ...spec.argv],
    }
  }

  // [CL-00A:ALLOW controlled_process_launcher]
  const spawn = hooks?.spawn ?? Bun.spawn
  let proc: Bun.Subprocess
  try {
    proc = spawn(finalArgv, { cwd: atSpawn.cwd, stdout: "pipe", stderr: "pipe", env: childEnv }) as Bun.Subprocess
  } catch (e) {
    return {
      outcome: "spawn_failed",
      reasonCode: "process_spawn_failed",
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
      appliedMode: plan.applied,
    }
  }

  let killedReason: "cancelled" | "timeout" | undefined
  const onAbort = () => {
    killedReason = "cancelled"
    killProcessTree(proc as { pid: number; kill: (c?: number) => void })
  }
  req.cancellation?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    killedReason = "timeout"
    killProcessTree(proc as { pid: number; kill: (c?: number) => void })
  }, req.timeoutMs)

  try {
    // Collect output + exit, but NEVER hang: once the tree has been killed, race
    // the drain against a short grace window. On a slow/failed OS reap (Windows
    // taskkill of a bash->sleep tree can leave a pipe half-open) a structured
    // timeout/aborted result still returns promptly instead of blocking the run
    // on a zombie.
    const collect = (async () => {
      const [stdout, stderr] = await Promise.all([
        drainStream(proc.stdout as ReadableStream, req.onOutput === undefined ? undefined : (text) => req.onOutput!({ stream: "stdout", text })),
        drainStream(proc.stderr as ReadableStream, req.onOutput === undefined ? undefined : (text) => req.onOutput!({ stream: "stderr", text })),
      ])
      const exitCode = await proc.exited
      return { stdout, stderr, exitCode }
    })()
    // If the grace timer wins, `collect` stays pending until the OS finally
    // reaps; swallow its eventual settle so a late resolve/reject never becomes
    // an unhandled rejection.
    void collect.catch(() => undefined)
    const GRACE_MS = 1_000
    let settled = false
    const graceTimers: ReturnType<typeof setTimeout>[] = []
    const graced = new Promise<null>((resolve) => {
      const check = () => {
        if (settled) return
        if (killedReason) graceTimers.push(setTimeout(() => resolve(null), GRACE_MS))
        else graceTimers.push(setTimeout(check, 50))
      }
      check()
    })
    const collected = (await Promise.race([collect, graced])) ?? { stdout: "", stderr: "", exitCode: null as number | null }
    settled = true
    for (const t of graceTimers) clearTimeout(t)
    return {
      outcome: "ran",
      exitCode: collected.exitCode,
      stdout: collected.stdout,
      stderr: collected.stderr,
      timedOut: killedReason === "timeout",
      aborted: killedReason === "cancelled",
      durationMs: Date.now() - t0,
      appliedMode: plan.applied,
      spawnedArgv: finalArgv,
    }
  } finally {
    clearTimeout(timer)
    req.cancellation?.removeEventListener("abort", onAbort)
  }
}
