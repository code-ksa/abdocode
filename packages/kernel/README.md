# @abdo/kernel — S104 contracts and the S105 journal

This package contains the dependency-free Rust/TypeScript contract boundary for
the Abdo Code kernel (S104) and the single-writer semantic journal (S105). The
S101 executable probe, FNV receipt, client and fixed probe protocol were retired
when S104 made the Cargo root a virtual workspace. There is still no production
kernel runtime, reducer or effect executor here — those are S106 onward.

## Source of truth

`crates/abdo-contracts/src/schema.rs` is the only contract schema. It declares
the IDs, commands, admission events, causation, opaque handles and digests,
`ProposedIntent`, `AdmittedIntent`, the discriminated target references and the
unverified trust receipt. Rust codecs and the TypeScript artifact are derived
from that schema.

The generated artifact is `src/generated/contracts.ts`. Do not edit it by hand.
The pinned, locked and offline codegen command emits canonical bytes; the
TypeScript harness writes a temporary file and compares those bytes. Updating
the tracked artifact requires the explicit write command:

```powershell
bun run contracts:check
bun run contracts:write
```

The public TypeScript surface is available from both `@abdo/kernel` and
`@abdo/kernel/contracts`.

## Security boundary

- Commands carry untrusted proposals. Rust admission later owns the transition
  to admitted intents.
- Policy, catalog, state and targets cross the boundary only as opaque handles
  and digests; no raw policy, secret or project configuration is authoritative.
- `UnverifiedTrustReceipt` is deliberately unverified. The generated helper
  only supplies canonical integrity bytes to a caller-provided verifier.
  Integrity acceptance is not issuer authority, workspace trust, freshness or
  policy admission.
- The contracts library performs no model work, cognition, network, process,
  filesystem or privileged effect. The codegen binary has only bounded
  argument/stdout and explicit artifact read/write access.
- The old S101 probe has no Cargo target, package export or production consumer.

## Gates

```powershell
bun run test
bun run typecheck
```

The test gate checks byte-stable codegen, the exact dependency-free Cargo
closure, strict wire mutations, Rust/TypeScript golden fixtures, a dedicated
release-mode 10,000,000-ID collision run, and the three S105 journal gates
(migration atomicity, 100k-event restore, 10,000 crash injections). The journal
gates alone take roughly half an hour; `bun run journal:test` runs just those.

### The journal (`crates/abdo-journal`)

One SQLite WAL database is the only durable semantic log. Events are append-only
and hash-chained; snapshots and projections are content-addressed and must name
the exact source event (`stream_sequence` + `event_hash`) they were derived
from, so a stale derivation fails closed instead of being silently accepted.
Append-only-ness is enforced by SQLite triggers, not by convention, and a second
live writer fails closed.

Every gate is a real subprocess bounded by an outer timeout, and its process
tree is killed and **proved reaped** before the harness reports a result. The
wait for that subprocess must be awaited: `Bun.spawn` publishes `exitCode` from
the event loop, so polling it synchronously around `Bun.sleepSync` blocks the
loop that would report the exit, and every gate burns its full timeout while
the child is already dead. See `awaitExitWithin` in
`scripts/s105-journal-test.ts`.
