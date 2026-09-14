/**
 * Capability registry (Sprint 19) — look before you install.
 *
 * The failure this removes is quiet and expensive: an agent installs a library
 * the project already has (a second copy, a second version, a lockfile churn),
 * or stands up a service on a port something else is already listening on, or
 * points it at a database name that already holds someone's data. None of these
 * announce themselves. The install "succeeds", the service "starts", and the
 * damage is found later by whoever owned the port or the schema.
 *
 * So the rule is an inventory FIRST, and a decision made against it:
 *
 *   install         — nothing here provides this; go ahead
 *   already_present — it exists; installing again buys nothing and risks churn
 *   conflict        — something else owns this port, name or database
 *
 * The registry is deliberately honest about its own blind spots. A scanner that
 * could not read a manifest reports `unknown`, and an unknown is never treated
 * as an absence: "I did not find it" and "it is not there" are different
 * claims, and only one of them justifies installing over the top of something.
 */

export type CapabilityKind = "library" | "tool" | "service" | "database"

export interface Capability {
  readonly kind: CapabilityKind
  /** Package name, binary name, service name, or database name. */
  readonly name: string
  readonly version?: string
  /** Where this was observed: a manifest path, PATH, a listening socket. */
  readonly source: string
  /** Port a service occupies, when the capability is a service. */
  readonly port?: number
}

export interface CapabilityInventory {
  readonly capabilities: readonly Capability[]
  /**
   * What the scan could NOT determine — an unreadable manifest, a port probe
   * that was not run. Present so a decision can refuse to be confident.
   */
  readonly blindSpots: readonly string[]
  readonly scannedAt: number
}

export const emptyInventory = (scannedAt = 0): CapabilityInventory => ({
  capabilities: [],
  blindSpots: [],
  scannedAt,
})

/** What is being proposed. */
export interface InstallCandidate {
  readonly kind: CapabilityKind
  readonly name: string
  readonly version?: string
  /** For a service: the port it intends to listen on. */
  readonly port?: number
  /** For a service: the database it intends to use. */
  readonly database?: string
}

export type InstallDecision = "install" | "already_present" | "conflict"

export interface InstallVerdict {
  readonly decision: InstallDecision
  readonly reason: string
  /** The capability that already provides or blocks this, when there is one. */
  readonly incumbent?: Capability
  /** True when the answer rests on something the scan could not see. */
  readonly uncertain?: boolean
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Decide what to do with a candidate, given what is already there.
 *
 * A version mismatch on a library is reported as `already_present`, not as a
 * conflict: the project has made a choice, and quietly installing a different
 * version over it is precisely the duplicate-install this sprint exists to
 * stop. Changing a version is a deliberate act, not a side effect of needing
 * the library.
 */
export function decideInstall(candidate: InstallCandidate, inventory: CapabilityInventory): InstallVerdict {
  const uncertain = inventory.blindSpots.length > 0

  // ── a port is owned by whoever is listening on it ─────────────────────
  if (candidate.port !== undefined) {
    const occupant = inventory.capabilities.find((c) => c.port === candidate.port && !sameName(c.name, candidate.name))
    if (occupant !== undefined) {
      return {
        decision: "conflict",
        reason: `port ${candidate.port} is already served by ${occupant.name} (${occupant.source})`,
        incumbent: occupant,
      }
    }
  }

  // ── a database name is owned by whatever already uses it ──────────────
  if (candidate.database !== undefined) {
    const owner = inventory.capabilities.find(
      (c) => c.kind === "database" && sameName(c.name, candidate.database!) && !sameName(c.name, candidate.name),
    )
    if (owner !== undefined) {
      return {
        decision: "conflict",
        reason: `database ${candidate.database} already exists (${owner.source})`,
        incumbent: owner,
      }
    }
  }

  // ── already provided? ─────────────────────────────────────────────────
  const incumbent = inventory.capabilities.find((c) => c.kind === candidate.kind && sameName(c.name, candidate.name))
  if (incumbent !== undefined) {
    const versionNote =
      candidate.version !== undefined && incumbent.version !== undefined && candidate.version !== incumbent.version
        ? ` at ${incumbent.version}, not ${candidate.version} — changing a version is a deliberate act, not a side effect`
        : incumbent.version !== undefined
          ? ` at ${incumbent.version}`
          : ""
    return {
      decision: "already_present",
      reason: `${candidate.kind} ${candidate.name} is already provided by ${incumbent.source}${versionNote}`,
      incumbent,
    }
  }

  // A service name that exists in another form (e.g. a systemd unit vs a
  // container) is a collision, not a fresh install.
  const nameClash = inventory.capabilities.find((c) => sameName(c.name, candidate.name) && c.kind !== candidate.kind)
  if (nameClash !== undefined && candidate.kind === "service") {
    return {
      decision: "conflict",
      reason: `the name ${candidate.name} is already taken by a ${nameClash.kind} (${nameClash.source})`,
      incumbent: nameClash,
    }
  }

  return {
    decision: "install",
    reason: uncertain
      ? `nothing found providing ${candidate.name}, but the scan had blind spots: ${inventory.blindSpots.join("; ")}`
      : `nothing in the inventory provides ${candidate.name}`,
    ...(uncertain ? { uncertain: true } : {}),
  }
}

/** Merge inventories from several scanners into one, keeping every blind spot. */
export function mergeInventories(...parts: readonly CapabilityInventory[]): CapabilityInventory {
  const capabilities: Capability[] = []
  const blindSpots: string[] = []
  let scannedAt = 0
  for (const part of parts) {
    for (const c of part.capabilities) {
      const duplicate = capabilities.some(
        (existing) => existing.kind === c.kind && sameName(existing.name, c.name) && existing.source === c.source,
      )
      if (!duplicate) capabilities.push(c)
    }
    for (const b of part.blindSpots) if (!blindSpots.includes(b)) blindSpots.push(b)
    scannedAt = Math.max(scannedAt, part.scannedAt)
  }
  return { capabilities, blindSpots, scannedAt }
}
