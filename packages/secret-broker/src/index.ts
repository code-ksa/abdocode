/**
 * @abdo/secret-broker — MS2 Phase 1.
 *
 * This is a HOST-ONLY contract. Model-visible callers receive SecretRef values
 * selected through a bounded visibility grant. Secret material is represented
 * by an opaque handle that moves directly from SecretProviderPort to
 * SecretInjectionPort and is never returned by SecretBroker.
 */
import { createHash, randomUUID } from "node:crypto"

export const SECRET_BROKER_CONTRACT_VERSION = 1 as const
export const MAX_METADATA_RESULTS = 64 as const

export type SecretProvider = "env" | "vault" | "os-keychain" | "windows-credential-manager" | "windows-dpapi"
export type SecretMode = "one_shot" | "reusable"
export type SecretEnvironment = "development" | "test" | "staging" | "production"
export type SecretCapability =
  | "api.authenticate"
  | "oauth.authorize"
  | "oauth.refresh"
  | "browser.session"
  | "email.read"
  | "email.write"
  | "social.publish"
  | "source.read"
  | "source.write"
  | "cloud.read"
  | "cloud.write"
  | "package.registry.read"

export type SecretOperationType =
  | "api.request"
  | "oauth.exchange"
  | "oauth.refresh"
  | "browser.session"
  | "email.read"
  | "email.send"
  | "social.publish"
  | "source.fetch"
  | "source.mutate"
  | "cloud.request"
  | "package.download"

export interface SecretScope {
  readonly projectId: string
  readonly environments: readonly SecretEnvironment[]
}

/** The only representation permitted in a model-visible surface. */
export interface SecretRef {
  readonly id: string
  readonly provider: SecretProvider
  readonly accountLabel: string
  readonly capabilities: readonly SecretCapability[]
  readonly scope: SecretScope
  readonly expiresAt: number
}

export interface ExecutableIdentity {
  readonly name: string
  readonly sha256: string
  readonly publisher?: string
}

export interface ApprovalProvenance {
  readonly approvalId: string
  readonly approvedBy: string
  readonly channel: "desktop" | "cli"
  readonly policyVersion: string
  readonly evidenceHash: string
  readonly decidedAt: number
  readonly expiresAt: number
}

/** Trusted-host identity; never serialized to a model as a whole. */
export interface SecretIdentity {
  readonly version: number
  readonly ref: SecretRef
  readonly permittedDestinations: readonly string[]
  readonly permittedExecutables: readonly ExecutableIdentity[]
  readonly permittedOperationTypes: readonly SecretOperationType[]
  readonly mode: SecretMode
  readonly approval: ApprovalProvenance
}

declare const secretMaterialHandleBrand: unique symbol
/** Nominal and deliberately fieldless. Adapters may only pass it through. */
export interface SecretMaterialHandle {
  readonly [secretMaterialHandleBrand]: "SecretMaterialHandle"
}

declare const secretRevocationFenceBrand: unique symbol
/** Invalidated by the revocation authority; never model-visible. */
export interface SecretRevocationFence {
  readonly [secretRevocationFenceBrand]: "SecretRevocationFence"
}

export interface SecretCreateRequest {
  readonly identity: SecretIdentity
  readonly material: SecretMaterialHandle
}

export interface SecretImportRequest extends SecretCreateRequest {
  /** Host-selected source reference; never a value or repository-local path. */
  readonly sourceRef: string
}

export interface SecretProviderRecoveryReport {
  readonly quarantinedHandles: number
  readonly removedTemporaryArtifacts: number
}

export interface SecretProviderPort {
  create(request: SecretCreateRequest): Promise<void>
  import(request: SecretImportRequest): Promise<void>
  openForInjection(secretId: string, expectedProvider: SecretProvider): Promise<SecretMaterialHandle | undefined>
  rotate(secretId: string, material: SecretMaterialHandle, expectedVersion: number): Promise<void>
  delete(secretId: string): Promise<void>
  recoverAfterCrash(): Promise<SecretProviderRecoveryReport>
}

export interface SecretMetadataPort {
  create(identity: SecretIdentity): Promise<boolean>
  read(secretId: string): Promise<SecretIdentity | undefined>
  /** There is intentionally no listAll. Unknown and unauthorized IDs are omitted. */
  listByIds(secretIds: readonly string[]): Promise<readonly SecretIdentity[]>
  replace(secretId: string, expectedVersion: number, next: SecretIdentity): Promise<boolean>
  delete(secretId: string, expectedVersion: number): Promise<boolean>
}

export interface SecretMetadataAccess {
  readonly accessId: string
  readonly approvalId: string
  readonly issuedBy: string
  readonly permittedSecretIds: readonly string[]
  readonly expiresAt: number
}

export interface SecretLeaseRequest {
  readonly secretId: string
  readonly runId: string
  readonly operationId: string
  readonly executable: ExecutableIdentity
  readonly operationType: SecretOperationType
  readonly destination: string
  readonly requiredCapabilities: readonly SecretCapability[]
  readonly ttlMs: number
  readonly maximumUses: number
}

export type SecretLeaseStatus =
  | "requested"
  | "approved"
  | "refused"
  | "armed"
  | "injected"
  | "active"
  | "consumed"
  | "revoked"
  | "expired"
  | "released"

export interface SecretLease {
  readonly version: number
  readonly leaseId: string
  readonly nonce: string
  readonly secretId: string
  readonly secretVersion: number
  readonly provider: SecretProvider
  readonly runId: string
  readonly operationId: string
  readonly executable: ExecutableIdentity
  readonly operationType: SecretOperationType
  readonly destination: string
  readonly capabilities: readonly SecretCapability[]
  readonly requestedAt: number
  readonly expiresAt: number
  readonly maximumUses: number
  readonly usedCount: number
  readonly mode: SecretMode
  readonly scopeHash: string
  readonly status: SecretLeaseStatus
  readonly approval?: ApprovalProvenance
  readonly reasonCode?: SecretBrokerErrorCode
}

export interface LeaseApproval extends ApprovalProvenance {
  readonly leaseId: string
  readonly scopeHash: string
}

export interface SecretLeasePort {
  create(lease: SecretLease): Promise<boolean>
  read(leaseId: string): Promise<SecretLease | undefined>
  compareAndSet(leaseId: string, expectedVersion: number, next: SecretLease): Promise<boolean>
  /** Single-use claim prevents one approval from authorizing two leases. */
  claimApproval(approvalId: string, subjectId: string): Promise<boolean>
  listBySecret(secretId: string): Promise<readonly SecretLease[]>
  listRecoverable(now: number): Promise<readonly SecretLease[]>
}

export interface RegisteredSecretBinding {
  readonly bindingId: string
  readonly channel: "environment" | "stdin" | "named_pipe" | "protected_file"
  readonly executableSha256: string
  readonly operationType: SecretOperationType
  readonly destination: string
}

export interface SecretInjectionReceipt {
  readonly receiptId: string
  readonly bindingId: string
  readonly processIdentityHash: string
  readonly injectedAt: number
}

export interface SecretInjectionPort {
  resolveBinding(lease: SecretLease): Promise<RegisteredSecretBinding | undefined>
  verifyExecutable(binding: RegisteredSecretBinding, executable: ExecutableIdentity): Promise<boolean>
  /** Must validate the revocation fence immediately before material handoff. */
  inject(request: {
    readonly material: SecretMaterialHandle
    readonly fence: SecretRevocationFence
    readonly binding: RegisteredSecretBinding
    readonly lease: SecretLease
    readonly attemptId: string
  }): Promise<SecretInjectionReceipt>
  recoverAfterCrash(): Promise<{ readonly removedInjectionArtifacts: number }>
}

export interface SecretRevocationPort {
  isSecretRevoked(secretId: string): Promise<boolean>
  acquireFence(secretId: string, leaseId: string): Promise<SecretRevocationFence | undefined>
  revokeLease(leaseId: string, reasonCode: SecretBrokerErrorCode): Promise<void>
  revokeSecret(secretId: string, reasonCode: SecretBrokerErrorCode): Promise<void>
  recoverAfterCrash(): Promise<{ readonly invalidatedFences: number }>
}

export type SecretAuditEventType =
  | "secret.create.requested"
  | "secret.created"
  | "secret.import.requested"
  | "secret.imported"
  | "secret.updated"
  | "secret.rotated"
  | "secret.deleted"
  | "secret.metadata.listed"
  | "secret.lease.requested"
  | "secret.lease.approved"
  | "secret.lease.refused"
  | "secret.lease.revoked"
  | "secret.lease.expired"
  | "secret.injection.requested"
  | "secret.injected"
  | "secret.injection.failed"
  | "secret.recovery.completed"

export interface SecretAuditEvent {
  readonly version: typeof SECRET_BROKER_CONTRACT_VERSION
  readonly eventId: string
  readonly type: SecretAuditEventType
  readonly occurredAt: number
  readonly secretId?: string
  readonly leaseId?: string
  readonly runId?: string
  readonly operationId?: string
  readonly executableSha256?: string
  readonly destination?: string
  readonly approvalId?: string
  readonly reasonCode?: SecretBrokerErrorCode
  readonly count?: number
}

export interface SecretAuditPort {
  /** Append-only. Failure must reject the operation. */
  append(event: SecretAuditEvent): Promise<void>
  history(secretId: string): Promise<readonly SecretAuditEvent[]>
}

export type SecretBrokerErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "ACCESS_EXPIRED"
  | "ACCESS_SCOPE_MISMATCH"
  | "METADATA_LIMIT_EXCEEDED"
  | "SECRET_EXPIRED"
  | "SECRET_REVOKED"
  | "CAPABILITY_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "EXECUTABLE_MISMATCH"
  | "OPERATION_MISMATCH"
  | "LEASE_EXPIRED"
  | "LEASE_STATE_CONFLICT"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_REPLAYED"
  | "BINDING_MISMATCH"
  | "INJECTION_REFUSED"
  | "AUDIT_WRITE_FAILED"
  | "PROVIDER_FAILURE"
  | "METADATA_FAILURE"
  | "RECOVERY_REQUIRED"
  | "ROTATED"
  | "DELETED"

export class SecretBrokerError extends Error {
  override readonly name = "SecretBrokerError"
  constructor(readonly code: SecretBrokerErrorCode) {
    super(code)
  }
}

export interface SecretAdminApproval extends ApprovalProvenance {
  readonly secretId: string
  readonly action: "update" | "rotate" | "delete"
}

export interface SecretBrokerOptions {
  readonly now?: () => number
  readonly idFactory?: (kind: "secret" | "lease" | "event" | "attempt") => string
  readonly maximumLeaseTtlMs?: number
  readonly maximumMetadataResults?: number
}

export interface SecretBrokerRecoveryReport {
  readonly releasedLeases: number
  readonly provider: SecretProviderRecoveryReport
  readonly removedInjectionArtifacts: number
  readonly invalidatedFences: number
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{7,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const DESTINATION = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/
const TERMINAL = new Set<SecretLeaseStatus>(["refused", "consumed", "revoked", "expired", "released"])

function fail(code: SecretBrokerErrorCode): never {
  throw new SecretBrokerError(code)
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function validateIdentifier(value: string): void {
  if (!ID.test(value) || value.includes("*")) fail("INVALID_REQUEST")
}

function validateExecutable(executable: ExecutableIdentity): void {
  if (!executable.name.trim() || !SHA256.test(executable.sha256)) fail("INVALID_REQUEST")
}

function normalizeDestination(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!DESTINATION.test(normalized) || normalized.includes("*")) fail("INVALID_REQUEST")
  return normalized
}

function validateApproval(approval: ApprovalProvenance, now: number): void {
  validateIdentifier(approval.approvalId)
  if (!approval.approvedBy.trim() || !approval.policyVersion.trim() || !SHA256.test(approval.evidenceHash))
    fail("INVALID_REQUEST")
  if (approval.decidedAt > now || approval.expiresAt <= now) fail("APPROVAL_MISMATCH")
}

function validateIdentity(identity: SecretIdentity, now: number): void {
  validateIdentifier(identity.ref.id)
  if (identity.version < 1 || !Number.isSafeInteger(identity.version)) fail("INVALID_REQUEST")
  if (!identity.ref.accountLabel.trim() || !identity.ref.scope.projectId.trim()) fail("INVALID_REQUEST")
  if (identity.ref.expiresAt <= now || identity.approval.expiresAt <= now) fail("SECRET_EXPIRED")
  if (identity.ref.capabilities.length === 0 || identity.permittedDestinations.length === 0) fail("INVALID_REQUEST")
  if (identity.permittedExecutables.length === 0 || identity.permittedOperationTypes.length === 0)
    fail("INVALID_REQUEST")
  if (unique(identity.ref.capabilities).length !== identity.ref.capabilities.length) fail("INVALID_REQUEST")
  for (const destination of identity.permittedDestinations) normalizeDestination(destination)
  for (const executable of identity.permittedExecutables) validateExecutable(executable)
  validateApproval(identity.approval, now)
}

function publicRef(identity: SecretIdentity): SecretRef {
  return {
    id: identity.ref.id,
    provider: identity.ref.provider,
    accountLabel: identity.ref.accountLabel,
    capabilities: [...identity.ref.capabilities],
    scope: { projectId: identity.ref.scope.projectId, environments: [...identity.ref.scope.environments] },
    expiresAt: identity.ref.expiresAt,
  }
}

export function secretLeaseScopeHash(
  input: Omit<SecretLease, "scopeHash" | "status" | "approval" | "reasonCode" | "version">,
): string {
  return digest({ contractVersion: SECRET_BROKER_CONTRACT_VERSION, ...input })
}

export class SecretBroker {
  private readonly now: () => number
  private readonly idFactory: NonNullable<SecretBrokerOptions["idFactory"]>
  private readonly maximumLeaseTtlMs: number
  private readonly maximumMetadataResults: number

  constructor(
    private readonly provider: SecretProviderPort,
    private readonly metadata: SecretMetadataPort,
    private readonly leases: SecretLeasePort,
    private readonly injection: SecretInjectionPort,
    private readonly revocations: SecretRevocationPort,
    private readonly auditPort: SecretAuditPort,
    options: SecretBrokerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID().replaceAll("-", "")}`)
    this.maximumLeaseTtlMs = options.maximumLeaseTtlMs ?? 5 * 60_000
    this.maximumMetadataResults = options.maximumMetadataResults ?? MAX_METADATA_RESULTS
  }

  private async audit(
    type: SecretAuditEventType,
    fields: Omit<SecretAuditEvent, "version" | "eventId" | "type" | "occurredAt"> = {},
  ): Promise<void> {
    try {
      await this.auditPort.append({
        version: SECRET_BROKER_CONTRACT_VERSION,
        eventId: this.idFactory("event"),
        type,
        occurredAt: this.now(),
        ...fields,
      })
    } catch {
      fail("AUDIT_WRITE_FAILED")
    }
  }

  async createCredential(request: SecretCreateRequest): Promise<SecretRef> {
    validateIdentity(request.identity, this.now())
    await this.audit("secret.create.requested", {
      secretId: request.identity.ref.id,
      approvalId: request.identity.approval.approvalId,
    })
    try {
      await this.provider.create(request)
    } catch {
      fail("PROVIDER_FAILURE")
    }
    let created = false
    try {
      created = await this.metadata.create(request.identity)
    } catch {
      try {
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      fail("METADATA_FAILURE")
    }
    if (!created) {
      try {
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      fail("ALREADY_EXISTS")
    }
    try {
      await this.audit("secret.created", {
        secretId: request.identity.ref.id,
        approvalId: request.identity.approval.approvalId,
      })
    } catch (error) {
      try {
        await this.metadata.delete(request.identity.ref.id, request.identity.version)
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      throw error
    }
    return publicRef(request.identity)
  }

  async importCredential(request: SecretImportRequest): Promise<SecretRef> {
    validateIdentity(request.identity, this.now())
    if (
      !/^(?:env|vault|os-keychain|windows-credential-manager|windows-dpapi):\/\/[A-Za-z0-9._/-]+$/.test(
        request.sourceRef,
      )
    ) {
      fail("INVALID_REQUEST")
    }
    await this.audit("secret.import.requested", {
      secretId: request.identity.ref.id,
      approvalId: request.identity.approval.approvalId,
    })
    try {
      await this.provider.import(request)
    } catch {
      fail("PROVIDER_FAILURE")
    }
    let created = false
    try {
      created = await this.metadata.create(request.identity)
    } catch {
      try {
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      fail("METADATA_FAILURE")
    }
    if (!created) {
      try {
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      fail("ALREADY_EXISTS")
    }
    try {
      await this.audit("secret.imported", {
        secretId: request.identity.ref.id,
        approvalId: request.identity.approval.approvalId,
      })
    } catch (error) {
      try {
        await this.metadata.delete(request.identity.ref.id, request.identity.version)
        await this.provider.delete(request.identity.ref.id)
      } catch {}
      throw error
    }
    return publicRef(request.identity)
  }

  async listMetadata(
    access: SecretMetadataAccess,
    requestedSecretIds: readonly string[],
  ): Promise<readonly SecretRef[]> {
    validateIdentifier(access.accessId)
    validateIdentifier(access.approvalId)
    if (access.expiresAt <= this.now()) fail("ACCESS_EXPIRED")
    if (requestedSecretIds.length === 0 || requestedSecretIds.length > this.maximumMetadataResults)
      fail("METADATA_LIMIT_EXCEEDED")
    const permitted = new Set(access.permittedSecretIds)
    const ids = unique(requestedSecretIds)
    for (const id of ids) validateIdentifier(id)
    const allowedIds = ids.filter((id) => permitted.has(id))
    const identities = allowedIds.length === 0 ? [] : await this.metadata.listByIds(allowedIds)
    const now = this.now()
    const refs = identities
      .filter((identity) => permitted.has(identity.ref.id) && identity.ref.expiresAt > now)
      .map(publicRef)
    await this.audit("secret.metadata.listed", { approvalId: access.approvalId, count: refs.length })
    return refs
  }

  async requestLease(request: SecretLeaseRequest): Promise<SecretLease> {
    validateIdentifier(request.secretId)
    validateIdentifier(request.runId)
    validateIdentifier(request.operationId)
    validateExecutable(request.executable)
    const destination = normalizeDestination(request.destination)
    if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0 || request.ttlMs > this.maximumLeaseTtlMs)
      fail("INVALID_REQUEST")
    if (!Number.isSafeInteger(request.maximumUses) || request.maximumUses <= 0) fail("INVALID_REQUEST")
    const identity = await this.metadata.read(request.secretId)
    if (!identity) fail("NOT_FOUND")
    const now = this.now()
    if (identity.ref.expiresAt <= now) fail("SECRET_EXPIRED")
    if (await this.revocations.isSecretRevoked(request.secretId)) {
      await this.audit("secret.lease.refused", {
        secretId: request.secretId,
        runId: request.runId,
        operationId: request.operationId,
        reasonCode: "SECRET_REVOKED",
      })
      fail("SECRET_REVOKED")
    }
    const capabilitySet = new Set(identity.ref.capabilities)
    if (
      request.requiredCapabilities.length === 0 ||
      request.requiredCapabilities.some((capability) => !capabilitySet.has(capability))
    ) {
      await this.audit("secret.lease.refused", {
        secretId: request.secretId,
        runId: request.runId,
        operationId: request.operationId,
        reasonCode: "CAPABILITY_MISMATCH",
      })
      fail("CAPABILITY_MISMATCH")
    }
    if (!identity.permittedDestinations.some((candidate) => normalizeDestination(candidate) === destination)) {
      await this.audit("secret.lease.refused", {
        secretId: request.secretId,
        runId: request.runId,
        operationId: request.operationId,
        reasonCode: "DESTINATION_MISMATCH",
      })
      fail("DESTINATION_MISMATCH")
    }
    if (
      !identity.permittedExecutables.some(
        (candidate) => candidate.sha256 === request.executable.sha256 && candidate.name === request.executable.name,
      )
    ) {
      await this.audit("secret.lease.refused", {
        secretId: request.secretId,
        runId: request.runId,
        operationId: request.operationId,
        reasonCode: "EXECUTABLE_MISMATCH",
      })
      fail("EXECUTABLE_MISMATCH")
    }
    if (!identity.permittedOperationTypes.includes(request.operationType)) {
      await this.audit("secret.lease.refused", {
        secretId: request.secretId,
        runId: request.runId,
        operationId: request.operationId,
        reasonCode: "OPERATION_MISMATCH",
      })
      fail("OPERATION_MISMATCH")
    }
    if (identity.mode === "one_shot" && request.maximumUses !== 1) fail("INVALID_REQUEST")
    const leaseId = this.idFactory("lease")
    const nonce = this.idFactory("attempt")
    const expiresAt = Math.min(now + request.ttlMs, identity.ref.expiresAt)
    const base = {
      leaseId,
      nonce,
      secretId: identity.ref.id,
      secretVersion: identity.version,
      provider: identity.ref.provider,
      runId: request.runId,
      operationId: request.operationId,
      executable: request.executable,
      operationType: request.operationType,
      destination,
      capabilities: unique(request.requiredCapabilities).sort(),
      requestedAt: now,
      expiresAt,
      maximumUses: request.maximumUses,
      usedCount: 0,
      mode: identity.mode,
    } satisfies Omit<SecretLease, "scopeHash" | "status" | "approval" | "reasonCode" | "version">
    const lease: SecretLease = { version: 0, ...base, scopeHash: secretLeaseScopeHash(base), status: "requested" }
    await this.audit("secret.lease.requested", {
      secretId: lease.secretId,
      leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      executableSha256: lease.executable.sha256,
      destination,
    })
    if (!(await this.leases.create(lease))) fail("LEASE_STATE_CONFLICT")
    return lease
  }

  async approveLease(leaseId: string, approval: LeaseApproval): Promise<SecretLease> {
    validateIdentifier(leaseId)
    const lease = await this.leases.read(leaseId)
    if (!lease) fail("NOT_FOUND")
    if (lease.status !== "requested") fail("LEASE_STATE_CONFLICT")
    if (lease.expiresAt <= this.now()) fail("LEASE_EXPIRED")
    validateApproval(approval, this.now())
    if (
      approval.leaseId !== lease.leaseId ||
      approval.scopeHash !== lease.scopeHash ||
      approval.expiresAt > lease.expiresAt
    )
      fail("APPROVAL_MISMATCH")
    if (!(await this.leases.claimApproval(approval.approvalId, lease.leaseId))) fail("APPROVAL_REPLAYED")
    const next: SecretLease = {
      ...lease,
      version: lease.version + 1,
      expiresAt: Math.min(lease.expiresAt, approval.expiresAt),
      status: "approved",
      approval,
    }
    if (!(await this.leases.compareAndSet(leaseId, lease.version, next))) fail("LEASE_STATE_CONFLICT")
    await this.audit("secret.lease.approved", {
      secretId: lease.secretId,
      leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      approvalId: approval.approvalId,
    })
    return next
  }

  async refuseLease(
    leaseId: string,
    approvalId: string,
    reasonCode: SecretBrokerErrorCode = "INJECTION_REFUSED",
  ): Promise<SecretLease> {
    validateIdentifier(leaseId)
    validateIdentifier(approvalId)
    const lease = await this.leases.read(leaseId)
    if (!lease) fail("NOT_FOUND")
    if (lease.status !== "requested") fail("LEASE_STATE_CONFLICT")
    const next: SecretLease = { ...lease, version: lease.version + 1, status: "refused", reasonCode }
    if (!(await this.leases.compareAndSet(leaseId, lease.version, next))) fail("LEASE_STATE_CONFLICT")
    await this.audit("secret.lease.refused", {
      secretId: lease.secretId,
      leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      approvalId,
      reasonCode,
    })
    return next
  }

  async inject(leaseId: string): Promise<SecretInjectionReceipt> {
    validateIdentifier(leaseId)
    const lease = await this.leases.read(leaseId)
    if (!lease) fail("NOT_FOUND")
    if (lease.status !== "approved") fail("LEASE_STATE_CONFLICT")
    if (lease.expiresAt <= this.now()) fail("LEASE_EXPIRED")
    const binding = await this.injection.resolveBinding(lease)
    if (
      !binding ||
      binding.executableSha256 !== lease.executable.sha256 ||
      binding.operationType !== lease.operationType ||
      normalizeDestination(binding.destination) !== lease.destination ||
      !(await this.injection.verifyExecutable(binding, lease.executable))
    ) {
      await this.audit("secret.injection.failed", {
        secretId: lease.secretId,
        leaseId,
        runId: lease.runId,
        operationId: lease.operationId,
        reasonCode: "BINDING_MISMATCH",
      })
      fail("BINDING_MISMATCH")
    }
    const attemptId = this.idFactory("attempt")
    await this.audit("secret.injection.requested", {
      secretId: lease.secretId,
      leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      executableSha256: lease.executable.sha256,
      destination: lease.destination,
      approvalId: lease.approval?.approvalId,
    })
    const armed: SecretLease = { ...lease, version: lease.version + 1, status: "armed" }
    if (!(await this.leases.compareAndSet(leaseId, lease.version, armed))) fail("LEASE_STATE_CONFLICT")
    const fence = await this.revocations.acquireFence(armed.secretId, armed.leaseId)
    if (!fence) {
      await this.releaseFailedInjection(armed, "SECRET_REVOKED")
      fail("SECRET_REVOKED")
    }
    if (!(await this.injection.verifyExecutable(binding, armed.executable))) {
      await this.releaseFailedInjection(armed, "EXECUTABLE_MISMATCH")
      fail("EXECUTABLE_MISMATCH")
    }
    const material = await this.provider.openForInjection(armed.secretId, armed.provider)
    if (!material) {
      await this.releaseFailedInjection(armed, "PROVIDER_FAILURE")
      fail("PROVIDER_FAILURE")
    }
    try {
      const receipt = await this.injection.inject({ material, fence, binding, lease: armed, attemptId })
      const usedCount = armed.usedCount + 1
      const status: SecretLeaseStatus = usedCount >= armed.maximumUses ? "consumed" : "approved"
      const next: SecretLease = { ...armed, version: armed.version + 1, usedCount, status }
      if (!(await this.leases.compareAndSet(leaseId, armed.version, next))) fail("RECOVERY_REQUIRED")
      await this.audit("secret.injected", {
        secretId: armed.secretId,
        leaseId,
        runId: armed.runId,
        operationId: armed.operationId,
        executableSha256: armed.executable.sha256,
        destination: armed.destination,
        approvalId: armed.approval?.approvalId,
      })
      return receipt
    } catch (error) {
      if (error instanceof SecretBrokerError) throw error
      await this.releaseFailedInjection(armed, "INJECTION_REFUSED")
      fail("INJECTION_REFUSED")
    }
  }

  private async releaseFailedInjection(lease: SecretLease, reasonCode: SecretBrokerErrorCode): Promise<void> {
    const current = await this.leases.read(lease.leaseId)
    if (current && current.status === "armed") {
      await this.leases.compareAndSet(current.leaseId, current.version, {
        ...current,
        version: current.version + 1,
        status: "released",
        reasonCode,
      })
    }
    await this.revocations.revokeLease(lease.leaseId, reasonCode)
    await this.audit("secret.injection.failed", {
      secretId: lease.secretId,
      leaseId: lease.leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      reasonCode,
    })
  }

  async revokeLease(leaseId: string, reasonCode: SecretBrokerErrorCode = "SECRET_REVOKED"): Promise<SecretLease> {
    validateIdentifier(leaseId)
    const lease = await this.leases.read(leaseId)
    if (!lease) fail("NOT_FOUND")
    if (TERMINAL.has(lease.status)) return lease
    await this.revocations.revokeLease(leaseId, reasonCode)
    const next: SecretLease = { ...lease, version: lease.version + 1, status: "revoked", reasonCode }
    if (!(await this.leases.compareAndSet(leaseId, lease.version, next))) fail("LEASE_STATE_CONFLICT")
    await this.audit("secret.lease.revoked", {
      secretId: lease.secretId,
      leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      reasonCode,
    })
    return next
  }

  async updateCredential(secretId: string, next: SecretIdentity, approval: SecretAdminApproval): Promise<SecretRef> {
    const current = await this.authorizeAdmin(secretId, "update", approval)
    validateIdentity(next, this.now())
    if (
      next.ref.id !== current.ref.id ||
      next.ref.provider !== current.ref.provider ||
      next.version !== current.version + 1
    )
      fail("INVALID_REQUEST")
    if (!(await this.metadata.replace(secretId, current.version, next))) fail("METADATA_FAILURE")
    await this.invalidateLeases(secretId, "ROTATED")
    await this.audit("secret.updated", { secretId, approvalId: approval.approvalId })
    return publicRef(next)
  }

  async rotateCredential(
    secretId: string,
    material: SecretMaterialHandle,
    next: SecretIdentity,
    approval: SecretAdminApproval,
  ): Promise<SecretRef> {
    const current = await this.authorizeAdmin(secretId, "rotate", approval)
    validateIdentity(next, this.now())
    if (
      next.ref.id !== current.ref.id ||
      next.ref.provider !== current.ref.provider ||
      next.version !== current.version + 1
    )
      fail("INVALID_REQUEST")
    try {
      await this.provider.rotate(secretId, material, current.version)
    } catch {
      fail("PROVIDER_FAILURE")
    }
    if (!(await this.metadata.replace(secretId, current.version, next))) fail("RECOVERY_REQUIRED")
    await this.invalidateLeases(secretId, "ROTATED")
    await this.audit("secret.rotated", { secretId, approvalId: approval.approvalId })
    return publicRef(next)
  }

  async deleteCredential(secretId: string, approval: SecretAdminApproval): Promise<void> {
    const current = await this.authorizeAdmin(secretId, "delete", approval)
    await this.revocations.revokeSecret(secretId, "DELETED")
    await this.invalidateLeases(secretId, "DELETED")
    try {
      await this.provider.delete(secretId)
    } catch {
      fail("PROVIDER_FAILURE")
    }
    if (!(await this.metadata.delete(secretId, current.version))) fail("RECOVERY_REQUIRED")
    await this.audit("secret.deleted", { secretId, approvalId: approval.approvalId, reasonCode: "DELETED" })
  }

  private async authorizeAdmin(
    secretId: string,
    action: SecretAdminApproval["action"],
    approval: SecretAdminApproval,
  ): Promise<SecretIdentity> {
    validateIdentifier(secretId)
    validateApproval(approval, this.now())
    if (approval.secretId !== secretId || approval.action !== action) fail("APPROVAL_MISMATCH")
    if (!(await this.leases.claimApproval(approval.approvalId, `admin_${action}_${secretId}`)))
      fail("APPROVAL_REPLAYED")
    const identity = await this.metadata.read(secretId)
    if (!identity) fail("NOT_FOUND")
    return identity
  }

  private async invalidateLeases(secretId: string, reasonCode: SecretBrokerErrorCode): Promise<void> {
    for (const lease of await this.leases.listBySecret(secretId)) {
      if (!TERMINAL.has(lease.status)) await this.revokeLease(lease.leaseId, reasonCode)
    }
  }

  async usageHistory(access: SecretMetadataAccess, secretId: string): Promise<readonly SecretAuditEvent[]> {
    validateIdentifier(secretId)
    if (access.expiresAt <= this.now()) fail("ACCESS_EXPIRED")
    if (!access.permittedSecretIds.includes(secretId)) fail("ACCESS_SCOPE_MISMATCH")
    return this.auditPort.history(secretId)
  }

  async expireAbandonedLeases(): Promise<number> {
    const now = this.now()
    let expired = 0
    for (const lease of await this.leases.listRecoverable(now)) {
      if (TERMINAL.has(lease.status) || lease.expiresAt > now) continue
      const next: SecretLease = { ...lease, version: lease.version + 1, status: "expired", reasonCode: "LEASE_EXPIRED" }
      if (!(await this.leases.compareAndSet(lease.leaseId, lease.version, next))) continue
      await this.revocations.revokeLease(lease.leaseId, "LEASE_EXPIRED")
      await this.audit("secret.lease.expired", {
        secretId: lease.secretId,
        leaseId: lease.leaseId,
        runId: lease.runId,
        operationId: lease.operationId,
        reasonCode: "LEASE_EXPIRED",
      })
      expired++
    }
    return expired
  }

  async recoverAfterHostCrash(): Promise<SecretBrokerRecoveryReport> {
    const provider = await this.provider.recoverAfterCrash().catch(() => fail("RECOVERY_REQUIRED"))
    const injection = await this.injection.recoverAfterCrash().catch(() => fail("RECOVERY_REQUIRED"))
    const revocations = await this.revocations.recoverAfterCrash().catch(() => fail("RECOVERY_REQUIRED"))
    let releasedLeases = 0
    for (const lease of await this.leases.listRecoverable(this.now())) {
      if (TERMINAL.has(lease.status)) continue
      await this.revocations.revokeLease(lease.leaseId, "RECOVERY_REQUIRED")
      const next: SecretLease = {
        ...lease,
        version: lease.version + 1,
        status: "released",
        reasonCode: "RECOVERY_REQUIRED",
      }
      if (await this.leases.compareAndSet(lease.leaseId, lease.version, next)) releasedLeases++
    }
    await this.audit("secret.recovery.completed", { count: releasedLeases })
    return {
      releasedLeases,
      provider,
      removedInjectionArtifacts: injection.removedInjectionArtifacts,
      invalidatedFences: revocations.invalidatedFences,
    }
  }
}
