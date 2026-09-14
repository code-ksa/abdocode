import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  MAX_METADATA_RESULTS,
  SecretBroker,
  SecretBrokerError,
  type ApprovalProvenance,
  type LeaseApproval,
  type RegisteredSecretBinding,
  type SecretAdminApproval,
  type SecretAuditEvent,
  type SecretAuditPort,
  type SecretIdentity,
  type SecretInjectionPort,
  type SecretInjectionReceipt,
  type SecretLease,
  type SecretLeasePort,
  type SecretMaterialHandle,
  type SecretMetadataAccess,
  type SecretMetadataPort,
  type SecretProviderPort,
  type SecretRevocationFence,
  type SecretRevocationPort,
} from "../src"

const START = 1_000_000
const CANARY = `canary_${randomUUID()}`
const EXE_HASH = "b".repeat(64)
const EVIDENCE_HASH = "a".repeat(64)

class MemoryProvider implements SecretProviderPort {
  readonly material = new Map<string, SecretMaterialHandle>()
  deleted: string[] = []
  failCreate = false
  recovered = 0

  async create(request: { identity: SecretIdentity; material: SecretMaterialHandle }): Promise<void> {
    if (this.failCreate) throw new Error(CANARY)
    this.material.set(request.identity.ref.id, request.material)
  }

  async import(request: {
    identity: SecretIdentity
    material: SecretMaterialHandle
    sourceRef: string
  }): Promise<void> {
    await this.create(request)
  }

  async openForInjection(secretId: string): Promise<SecretMaterialHandle | undefined> {
    return this.material.get(secretId)
  }

  async rotate(secretId: string, material: SecretMaterialHandle): Promise<void> {
    if (!this.material.has(secretId)) throw new Error(CANARY)
    this.material.set(secretId, material)
  }

  async delete(secretId: string): Promise<void> {
    this.material.delete(secretId)
    this.deleted.push(secretId)
  }

  async recoverAfterCrash() {
    this.recovered++
    return { quarantinedHandles: 0, removedTemporaryArtifacts: 0 }
  }
}

class MemoryMetadata implements SecretMetadataPort {
  readonly records = new Map<string, SecretIdentity>()
  failCreate = false

  async create(identity: SecretIdentity): Promise<boolean> {
    if (this.failCreate) throw new Error(CANARY)
    if (this.records.has(identity.ref.id)) return false
    this.records.set(identity.ref.id, identity)
    return true
  }

  async read(secretId: string): Promise<SecretIdentity | undefined> {
    return this.records.get(secretId)
  }

  async listByIds(secretIds: readonly string[]): Promise<readonly SecretIdentity[]> {
    return secretIds.flatMap((id) => {
      const found = this.records.get(id)
      return found ? [found] : []
    })
  }

  async replace(secretId: string, expectedVersion: number, next: SecretIdentity): Promise<boolean> {
    const current = this.records.get(secretId)
    if (!current || current.version !== expectedVersion) return false
    this.records.set(secretId, next)
    return true
  }

  async delete(secretId: string, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(secretId)
    if (!current || current.version !== expectedVersion) return false
    return this.records.delete(secretId)
  }
}

class MemoryLeases implements SecretLeasePort {
  readonly records = new Map<string, SecretLease>()
  readonly approvals = new Map<string, string>()
  forceCasFailure = false

  async create(lease: SecretLease): Promise<boolean> {
    if (this.records.has(lease.leaseId)) return false
    this.records.set(lease.leaseId, lease)
    return true
  }

  async read(leaseId: string): Promise<SecretLease | undefined> {
    return this.records.get(leaseId)
  }

  async compareAndSet(leaseId: string, expectedVersion: number, next: SecretLease): Promise<boolean> {
    if (this.forceCasFailure) return false
    const current = this.records.get(leaseId)
    if (!current || current.version !== expectedVersion) return false
    this.records.set(leaseId, next)
    return true
  }

  async claimApproval(approvalId: string, subjectId: string): Promise<boolean> {
    if (this.approvals.has(approvalId)) return false
    this.approvals.set(approvalId, subjectId)
    return true
  }

  async listBySecret(secretId: string): Promise<readonly SecretLease[]> {
    return [...this.records.values()].filter((lease) => lease.secretId === secretId)
  }

  async listRecoverable(): Promise<readonly SecretLease[]> {
    return [...this.records.values()]
  }
}

class MemoryInjection implements SecretInjectionPort {
  binding: RegisteredSecretBinding = {
    bindingId: "binding_primary01",
    channel: "environment",
    executableSha256: EXE_HASH,
    operationType: "api.request",
    destination: "api.example.test:443",
  }
  executableValid = true
  injectedMaterial?: SecretMaterialHandle
  injectedLease?: SecretLease
  recovered = 0

  async resolveBinding(): Promise<RegisteredSecretBinding | undefined> {
    return this.binding
  }

  async verifyExecutable(): Promise<boolean> {
    return this.executableValid
  }

  async inject(request: { material: SecretMaterialHandle; lease: SecretLease }): Promise<SecretInjectionReceipt> {
    this.injectedMaterial = request.material
    this.injectedLease = request.lease
    return {
      receiptId: "receipt_primary01",
      bindingId: this.binding.bindingId,
      processIdentityHash: "c".repeat(64),
      injectedAt: START + 100,
    }
  }

  async recoverAfterCrash() {
    this.recovered++
    return { removedInjectionArtifacts: 0 }
  }
}

class MemoryRevocations implements SecretRevocationPort {
  readonly leases = new Set<string>()
  readonly secrets = new Set<string>()
  recovered = 0
  readonly fence = {} as SecretRevocationFence

  async isSecretRevoked(secretId: string): Promise<boolean> {
    return this.secrets.has(secretId)
  }

  async acquireFence(secretId: string, leaseId: string): Promise<SecretRevocationFence | undefined> {
    return this.secrets.has(secretId) || this.leases.has(leaseId) ? undefined : this.fence
  }

  async revokeLease(leaseId: string): Promise<void> {
    this.leases.add(leaseId)
  }

  async revokeSecret(secretId: string): Promise<void> {
    this.secrets.add(secretId)
  }

  async recoverAfterCrash() {
    this.recovered++
    return { invalidatedFences: 0 }
  }
}

class MemoryAudit implements SecretAuditPort {
  readonly events: SecretAuditEvent[] = []
  fail = false

  async append(event: SecretAuditEvent): Promise<void> {
    if (this.fail) throw new Error(CANARY)
    this.events.push(event)
  }

  async history(secretId: string): Promise<readonly SecretAuditEvent[]> {
    return this.events.filter((event) => event.secretId === secretId)
  }
}

function approval(id = "approval_primary01", expiresAt = START + 90_000): ApprovalProvenance {
  return {
    approvalId: id,
    approvedBy: "human_owner",
    channel: "desktop",
    policyVersion: "policy_v1",
    evidenceHash: EVIDENCE_HASH,
    decidedAt: START - 1,
    expiresAt,
  }
}

function identity(overrides: Partial<SecretIdentity> = {}): SecretIdentity {
  const base: SecretIdentity = {
    version: 1,
    ref: {
      id: "secret_primary01",
      provider: "windows-dpapi",
      accountLabel: "Primary test account",
      capabilities: ["api.authenticate", "source.read"],
      scope: { projectId: "project_abdo01", environments: ["test"] },
      expiresAt: START + 100_000,
    },
    permittedDestinations: ["api.example.test:443"],
    permittedExecutables: [{ name: "fixture-client.exe", sha256: EXE_HASH }],
    permittedOperationTypes: ["api.request"],
    mode: "one_shot",
    approval: approval(),
  }
  return { ...base, ...overrides }
}

function access(ids = ["secret_primary01"]): SecretMetadataAccess {
  return {
    accessId: "access_primary01",
    approvalId: "approval_access01",
    issuedBy: "trusted_host",
    permittedSecretIds: ids,
    expiresAt: START + 10_000,
  }
}

function harness() {
  let now = START
  let sequence = 0
  const provider = new MemoryProvider()
  const metadata = new MemoryMetadata()
  const leases = new MemoryLeases()
  const injection = new MemoryInjection()
  const revocations = new MemoryRevocations()
  const audit = new MemoryAudit()
  const broker = new SecretBroker(provider, metadata, leases, injection, revocations, audit, {
    now: () => now,
    idFactory: (kind) => `${kind}_${String(++sequence).padStart(8, "0")}`,
  })
  const material = { testOnlyCanary: CANARY } as unknown as SecretMaterialHandle
  return {
    broker,
    provider,
    metadata,
    leases,
    injection,
    revocations,
    audit,
    material,
    setNow(value: number) {
      now = value
    },
  }
}

async function createAndRequest(h = harness()) {
  await h.broker.createCredential({ identity: identity(), material: h.material })
  const lease = await h.broker.requestLease({
    secretId: "secret_primary01",
    runId: "run_phase100",
    operationId: "operation_100",
    executable: { name: "fixture-client.exe", sha256: EXE_HASH },
    operationType: "api.request",
    destination: "API.EXAMPLE.TEST:443",
    requiredCapabilities: ["api.authenticate"],
    ttlMs: 10_000,
    maximumUses: 1,
  })
  return { h, lease }
}

function leaseApproval(lease: SecretLease, id = "approval_lease001"): LeaseApproval {
  return { ...approval(id, lease.expiresAt), leaseId: lease.leaseId, scopeHash: lease.scopeHash }
}

function adminApproval(action: SecretAdminApproval["action"], id: string): SecretAdminApproval {
  return { ...approval(id), secretId: "secret_primary01", action }
}

describe("MS2 Phase 1 Secret Broker", () => {
  test("model-visible values contain metadata only and never material", async () => {
    const h = harness()
    const ref = await h.broker.createCredential({ identity: identity(), material: h.material })
    expect(Object.keys(ref).sort()).toEqual(["accountLabel", "capabilities", "expiresAt", "id", "provider", "scope"])
    expect(JSON.stringify(ref)).not.toContain(CANARY)
    expect(JSON.stringify(h.audit.events)).not.toContain(CANARY)
    expect(h.provider.material.get(ref.id)).toBe(h.material)
  })

  test("metadata lookup is bounded, scoped and has no list-all or existence oracle", async () => {
    const h = harness()
    await h.broker.createCredential({ identity: identity(), material: h.material })
    expect((h.broker as unknown as Record<string, unknown>).listAll).toBeUndefined()
    expect(await h.broker.listMetadata(access(), ["secret_primary01", "secret_unknown01"])).toHaveLength(1)
    expect(await h.broker.listMetadata(access(["secret_unknown01"]), ["secret_unknown01"])).toEqual([])
    expect(await h.broker.listMetadata(access([]), ["secret_primary01"])).toEqual([])
    const tooMany = Array.from(
      { length: MAX_METADATA_RESULTS + 1 },
      (_, index) => `secret_${String(index).padStart(8, "0")}`,
    )
    await expect(h.broker.listMetadata(access(tooMany), tooMany)).rejects.toMatchObject({
      code: "METADATA_LIMIT_EXCEEDED",
    })
  })

  test("lease identity binds capability, destination, executable and operation", async () => {
    const h = harness()
    await h.broker.createCredential({ identity: identity(), material: h.material })
    const request = {
      secretId: "secret_primary01",
      runId: "run_phase100",
      operationId: "operation_100",
      executable: { name: "fixture-client.exe", sha256: EXE_HASH },
      operationType: "api.request" as const,
      destination: "api.example.test:443",
      requiredCapabilities: ["api.authenticate" as const],
      ttlMs: 10_000,
      maximumUses: 1,
    }
    await expect(h.broker.requestLease({ ...request, destination: "other.example.test:443" })).rejects.toMatchObject({
      code: "DESTINATION_MISMATCH",
    })
    await expect(
      h.broker.requestLease({ ...request, executable: { ...request.executable, sha256: "d".repeat(64) } }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_MISMATCH" })
    await expect(h.broker.requestLease({ ...request, operationType: "source.fetch" })).rejects.toMatchObject({
      code: "OPERATION_MISMATCH",
    })
    await expect(h.broker.requestLease({ ...request, requiredCapabilities: ["cloud.write"] })).rejects.toMatchObject({
      code: "CAPABILITY_MISMATCH",
    })
    expect(h.audit.events.filter((event) => event.type === "secret.lease.refused")).toHaveLength(4)
  })

  test("scope hashes are deterministic, nonce-bound and approvals are single-use", async () => {
    const first = await createAndRequest()
    const secondLease = await first.h.broker.requestLease({
      secretId: "secret_primary01",
      runId: "run_phase100",
      operationId: "operation_100",
      executable: { name: "fixture-client.exe", sha256: EXE_HASH },
      operationType: "api.request",
      destination: "api.example.test:443",
      requiredCapabilities: ["api.authenticate"],
      ttlMs: 10_000,
      maximumUses: 1,
    })
    expect(first.lease.scopeHash).toHaveLength(64)
    expect(secondLease.scopeHash).not.toBe(first.lease.scopeHash)
    await first.h.broker.approveLease(first.lease.leaseId, leaseApproval(first.lease, "approval_replay01"))
    await expect(
      first.h.broker.approveLease(secondLease.leaseId, leaseApproval(secondLease, "approval_replay01")),
    ).rejects.toMatchObject({ code: "APPROVAL_REPLAYED" })
  })

  test("approval expiry shortens the approved lease lifetime", async () => {
    const { h, lease } = await createAndRequest()
    const shortExpiry = START + 1_000
    const approved = await h.broker.approveLease(lease.leaseId, {
      ...leaseApproval(lease),
      expiresAt: shortExpiry,
    })
    expect(approved.expiresAt).toBe(shortExpiry)
    h.setNow(shortExpiry)
    await expect(h.broker.inject(lease.leaseId)).rejects.toMatchObject({ code: "LEASE_EXPIRED" })
  })

  test("approved injection uses a registered binding and returns no material", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    const receipt = await h.broker.inject(lease.leaseId)
    expect(receipt.bindingId).toBe("binding_primary01")
    expect(h.injection.injectedMaterial).toBe(h.material)
    expect(JSON.stringify(receipt)).not.toContain(CANARY)
    expect(JSON.stringify(h.audit.events)).not.toContain(CANARY)
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "consumed", usedCount: 1 })
    await expect(h.broker.inject(lease.leaseId)).rejects.toMatchObject({ code: "LEASE_STATE_CONFLICT" })
  })

  test("injection re-verifies executable identity and fails closed", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    h.injection.executableValid = false
    await expect(h.broker.inject(lease.leaseId)).rejects.toMatchObject({ code: "BINDING_MISMATCH" })
    expect(h.injection.injectedMaterial).toBeUndefined()
    expect(h.audit.events.at(-1)).toMatchObject({ type: "secret.injection.failed", reasonCode: "BINDING_MISMATCH" })
  })

  test("a revocation fence refusal releases the armed lease without injection", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    h.revocations.leases.add(lease.leaseId)
    await expect(h.broker.inject(lease.leaseId)).rejects.toMatchObject({ code: "SECRET_REVOKED" })
    expect(h.injection.injectedMaterial).toBeUndefined()
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "released", reasonCode: "SECRET_REVOKED" })
  })

  test("a revoked secret cannot mint a new lease", async () => {
    const h = harness()
    await h.broker.createCredential({ identity: identity(), material: h.material })
    h.revocations.secrets.add("secret_primary01")
    await expect(
      h.broker.requestLease({
        secretId: "secret_primary01",
        runId: "run_phase100",
        operationId: "operation_100",
        executable: { name: "fixture-client.exe", sha256: EXE_HASH },
        operationType: "api.request",
        destination: "api.example.test:443",
        requiredCapabilities: ["api.authenticate"],
        ttlMs: 10_000,
        maximumUses: 1,
      }),
    ).rejects.toMatchObject({ code: "SECRET_REVOKED" })
  })

  test("expired leases cannot be approved or injected", async () => {
    const { h, lease } = await createAndRequest()
    h.setNow(lease.expiresAt)
    await expect(h.broker.approveLease(lease.leaseId, leaseApproval(lease))).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    })
    expect(await h.broker.expireAbandonedLeases()).toBe(1)
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "expired" })
  })

  test("a compare-and-set race has no side effect", async () => {
    const { h, lease } = await createAndRequest()
    h.leases.forceCasFailure = true
    await expect(h.broker.approveLease(lease.leaseId, leaseApproval(lease))).rejects.toMatchObject({
      code: "LEASE_STATE_CONFLICT",
    })
    expect(h.injection.injectedMaterial).toBeUndefined()
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "requested" })
  })

  test("rotation invalidates prior leases and old material", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    const nextMaterial = { next: "opaque" } as unknown as SecretMaterialHandle
    const next = identity({ version: 2, approval: approval("approval_identity02") })
    await h.broker.rotateCredential(
      "secret_primary01",
      nextMaterial,
      next,
      adminApproval("rotate", "approval_rotate01"),
    )
    expect(h.provider.material.get("secret_primary01")).toBe(nextMaterial)
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "revoked", reasonCode: "ROTATED" })
  })

  test("delete revokes active leases, destroys provider material and retains a tombstone", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    await h.broker.deleteCredential("secret_primary01", adminApproval("delete", "approval_delete01"))
    expect(h.provider.material.has("secret_primary01")).toBeFalse()
    expect(await h.metadata.read("secret_primary01")).toBeUndefined()
    expect(h.revocations.secrets.has("secret_primary01")).toBeTrue()
    expect(h.audit.events.at(-1)).toMatchObject({ type: "secret.deleted", reasonCode: "DELETED" })
  })

  test("crash recovery releases every non-terminal lease before returning", async () => {
    const { h, lease } = await createAndRequest()
    await h.broker.approveLease(lease.leaseId, leaseApproval(lease))
    const report = await h.broker.recoverAfterHostCrash()
    expect(report.releasedLeases).toBe(1)
    expect(await h.leases.read(lease.leaseId)).toMatchObject({ status: "released", reasonCode: "RECOVERY_REQUIRED" })
    expect(h.provider.recovered).toBe(1)
    expect(h.injection.recovered).toBe(1)
    expect(h.revocations.recovered).toBe(1)
  })

  test("audit failure denies credential creation before provider side effects", async () => {
    const h = harness()
    h.audit.fail = true
    await expect(h.broker.createCredential({ identity: identity(), material: h.material })).rejects.toMatchObject({
      code: "AUDIT_WRITE_FAILED",
    })
    expect(h.provider.material.size).toBe(0)
  })

  test("metadata failure compensates provider creation without leaking its error", async () => {
    const h = harness()
    h.metadata.failCreate = true
    let caught: unknown
    try {
      await h.broker.createCredential({ identity: identity(), material: h.material })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SecretBrokerError)
    expect(caught).toMatchObject({ code: "METADATA_FAILURE", message: "METADATA_FAILURE" })
    expect(JSON.stringify(caught)).not.toContain(CANARY)
    expect(h.provider.material.size).toBe(0)
  })

  test("import and scoped usage history remain reference-only", async () => {
    const h = harness()
    const ref = await h.broker.importCredential({
      identity: identity(),
      material: h.material,
      sourceRef: "os-keychain://selected-entry",
    })
    const history = await h.broker.usageHistory(access(), ref.id)
    expect(history.map((event) => event.type)).toEqual(["secret.import.requested", "secret.imported"])
    expect(JSON.stringify(history)).not.toContain(CANARY)
    await expect(h.broker.usageHistory(access([]), ref.id)).rejects.toMatchObject({ code: "ACCESS_SCOPE_MISMATCH" })
  })

  test("import accepts only registered reference schemes and compensates metadata failure", async () => {
    const h = harness()
    await expect(
      h.broker.importCredential({ identity: identity(), material: h.material, sourceRef: "C:/unsafe/plaintext.txt" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    h.metadata.failCreate = true
    await expect(
      h.broker.importCredential({
        identity: identity(),
        material: h.material,
        sourceRef: "os-keychain://selected-entry",
      }),
    ).rejects.toMatchObject({ code: "METADATA_FAILURE" })
    expect(h.provider.material.size).toBe(0)
  })
})
