/**
 * CL-16A2-D-L — one independent process contending for a lease.
 *
 * Several of these run at once against ONE SQLite file. That is the entire point
 * of the slice: the lease ledger's safety rests on `BEGIN IMMEDIATE` plus
 * `expectedSequence`, and neither can be exercised by an in-process
 * `Promise.all` over a `MemoryEventStore`.
 *
 * It optionally performs the REAL ACL grant and restore, guarded by the lease's
 * `mustGrant` / `mustRevoke`, so "the first run finishing did not revoke the
 * second run's access" is a statement about a real DACL rather than about a
 * counter.
 *
 * Every worker appends one JSON line per event to its log: pid, runId,
 * stateEpoch, leaseId, resource identity, expected/observed sequence, and the
 * result. No secrets, no file content, no environment values.
 *
 *   bun lease-worker.ts --db <f> --run <id> --identity <s> --sid <s> --rights rx
 *                       --barrier <dir> --peers <n> --log <f> --mode <m>
 *                       [--path <dir>] [--die-at acquired|released] [--marker <f>]
 */
import { appendFileSync } from "node:fs"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { acquireLease, releaseLease, type LeaseAttempt } from "../../src/leases"
import { barrier } from "../barrier"
import { harnessHelperRunner } from "../harness"

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const dbPath = arg("db")
const runId = arg("run")
const identity = arg("identity")
const sid = arg("sid")
const rights = arg("rights", "rx") as "rx" | "modify"
const barrierDir = arg("barrier")
const peers = Number(arg("peers", "2"))
const logPath = arg("log")
const mode = arg("mode", "acquire-release")
const path = arg("path")
const dieAt = arg("die-at")
const marker = arg("marker")
const originalSddl = arg("orig")
const stateEpoch = Number(arg("epoch", "0"))
const collide = process.argv.includes("--collide")

const log = (event: string, extra: Record<string, unknown> = {}) => {
  appendFileSync(
    logPath,
    `${JSON.stringify({ event, pid: process.pid, runId, stateEpoch, resourceIdentity: identity, sid, rights, at: Date.now(), ...extra })}\n`,
    "utf8",
  )
}

/** Every ledger attempt is recorded, including the ones that lost the race. */
const observe = (a: LeaseAttempt) =>
  log("lease_attempt", {
    op: a.op,
    leaseId: a.key,
    attempt: a.attempt,
    expectedSequence: a.expectedSequence,
    observedSequence: a.observedSequence,
    outcome: a.outcome,
    holders: a.holders.length,
  })

const store = new SqliteEventStore(dbPath)
const helper = harnessHelperRunner()

/** Stop being a process that makes progress, so the parent can kill us. */
const parkForKill = async (why: string) => {
  log("parked", { why })
  if (marker) await Bun.write(marker, why)
  await new Promise(() => {})
}

try {
  log("start", { mode, dieAt: dieAt || null })

  // ---- everyone arrives, then everyone acquires at once
  await barrier(barrierDir, "acquire", runId, peers)
  // FORCED, DETERMINISTIC CONTENTION: every worker reads the ledger, then all of
  // them wait here, then all of them append. Exactly one can win the
  // expectedSequence race and the rest must conflict — on every run, not on
  // lucky ones. Only enabled when the parent asks for it.
  const lease = await acquireLease(store, { resourceIdentity: identity, sid, rights }, runId, {
    observe,
    ...(collide ? { beforeAppend: () => barrier(barrierDir, "pre-append", runId, peers) } : {}),
  })
  log("acquired", { leaseId: lease.ref.key, mustGrant: lease.mustGrant, holders: lease.holders.length })

  // The OS grant happens ONLY for the holder the ledger elected.
  if (path && lease.mustGrant) {
    const g = await helper({ argv: ["grant-acl", "--path", path, "--sid", sid, "--rights", rights] })
    log("granted", { ok: g.ok === true })
  }

  if (dieAt === "acquired") await parkForKill("died after acquire, before any completion event")

  if (mode === "acquire-hold") {
    // Take the lease and stay a holder: the peer's release must NOT revoke.
    await barrier(barrierDir, "held", runId, peers)
    log("holding")
    await barrier(barrierDir, "hold-done", runId, peers)
  }

  if (mode === "acquire-release" || mode === "acquire-hold") {
    if (mode === "acquire-release") await barrier(barrierDir, "release", runId, peers)
    const rel = await releaseLease(store, lease.ref.key, runId, { observe })
    log("released", { leaseId: lease.ref.key, mustRevoke: rel.mustRevoke, wasHolder: rel.wasHolder, holders: rel.holders.length })

    if (dieAt === "released") await parkForKill("died after the release landed, before removing the ACE")

    // The ACE is removed ONLY by the last holder out.
    if (path && rel.mustRevoke) {
      const r = await helper({ argv: ["restore-acl", "--path", path, "--sid", sid, "--expect-granted-sddl", "", "--original-sddl", originalSddl] })
      log("revoked", { ok: r.ok === true, mode: String(r.mode ?? "") })
    }
  }

  if (mode === "double-release") {
    const first = await releaseLease(store, lease.ref.key, runId, { observe })
    const second = await releaseLease(store, lease.ref.key, runId, { observe })
    log("double_release", { firstMustRevoke: first.mustRevoke, secondMustRevoke: second.mustRevoke })
  }

  log("done")
  process.exit(0)
} catch (e) {
  log("error", { message: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : String(e).slice(0, 300) })
  process.exit(1)
}
