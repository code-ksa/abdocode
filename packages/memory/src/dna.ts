/**
 * Project DNA (Sprint 78) and the `.abdo` manifest (Sprint 79).
 *
 * Every agent that meets a new repository guesses. It sees a `package.json`
 * and concludes npm; it sees a `Dockerfile` and concludes the deploy is docker;
 * it sees `next` in the dependencies and concludes `npm run build`. Each guess
 * is right most of the time, which is exactly what makes it dangerous: the
 * failures are rare, confident, and land in production.
 *
 * So discovery here is BY MEASUREMENT, and a trait nobody measured is `unknown`
 * — never a plausible default. `unknown` is more useful than a good guess,
 * because it is the only value that makes an agent go and look.
 *
 * Sprint 79 is the other half. A month later, "how is this project deployed?"
 * should be answered from a file, not by repeating the discovery — and the file
 * records HOW each trait was learned, so a stale entry can be told from a
 * measured one.
 */

export type Confidence = "measured" | "declared" | "inferred" | "unknown"

export interface Trait<T> {
  readonly value: T | undefined
  readonly confidence: Confidence
  /** What was actually observed. "detected npm" is not evidence. */
  readonly evidence: string
  /** When it was learned, so staleness is visible. */
  readonly at: number
}

export const unknownTrait = <T>(why: string): Trait<T> => ({
  value: undefined,
  confidence: "unknown",
  evidence: why,
  at: 0,
})

export interface ProjectDna {
  readonly projectId: string
  readonly packageManager: Trait<string>
  readonly buildCommand: Trait<string>
  readonly testCommand: Trait<string>
  readonly devCommand: Trait<string>
  readonly deployMethod: Trait<string>
  readonly runtimeVersion: Trait<string>
  readonly database: Trait<string>
  readonly criticalPaths: Trait<readonly string[]>
  readonly learnedAt: number
}

/** A measurement the discovery may perform: run something and read the result. */
export interface Observation {
  readonly what: string
  readonly command?: string
  readonly exitCode?: number | null
  readonly output?: string
  readonly file?: string
  readonly fileContent?: string
}

/**
 * Learn a trait from an observation, or admit that nothing was learned.
 *
 * The `inferred` level exists and is deliberately weaker than `measured`: a
 * lockfile tells you which manager INSTALLED this project, which is strong
 * evidence and still not the same as having run it. Keeping the two apart is
 * what lets a later step decide whether to trust it.
 */
export function learn<T>(observation: Observation, extract: (o: Observation) => T | undefined, confidence: Confidence, at: number): Trait<T> {
  const value = extract(observation)
  if (value === undefined)
    return {
      value: undefined,
      confidence: "unknown",
      evidence: `${observation.what}: nothing conclusive — a plausible default here would be a guess wearing a fact's clothes`,
      at,
    }
  return { value, confidence, evidence: observation.what, at }
}

/**
 * Which traits are still unknown, and therefore still need looking at.
 *
 * The list is the deliverable of discovery, not a failure of it. A DNA with
 * four unknowns and honest evidence is more useful than one with zero unknowns
 * and four guesses, because only the first tells an agent where to go.
 */
export function unknowns(dna: ProjectDna): string[] {
  const entries: [string, Trait<unknown>][] = [
    ["packageManager", dna.packageManager],
    ["buildCommand", dna.buildCommand],
    ["testCommand", dna.testCommand],
    ["devCommand", dna.devCommand],
    ["deployMethod", dna.deployMethod],
    ["runtimeVersion", dna.runtimeVersion],
    ["database", dna.database],
    ["criticalPaths", dna.criticalPaths],
  ]
  return entries.filter(([, t]) => t.confidence === "unknown" || t.value === undefined).map(([name]) => name)
}

/**
 * Traits weak enough that acting on them needs a second look.
 *
 * `inferred` is included: it is good evidence and it is not a measurement, and
 * the difference matters most for exactly the traits that hurt — a deploy
 * method inferred from a Dockerfile is how an agent deploys a project that is
 * actually released through a pipeline the Dockerfile only feeds.
 */
export const weakTraits = (dna: ProjectDna): string[] => {
  const entries: [string, Trait<unknown>][] = [
    ["buildCommand", dna.buildCommand],
    ["testCommand", dna.testCommand],
    ["deployMethod", dna.deployMethod],
    ["database", dna.database],
  ]
  return entries.filter(([, t]) => t.confidence === "inferred").map(([name]) => name)
}

// --------------------------------------------------------------------------
// Sprint 79 — the manifest
// --------------------------------------------------------------------------

export const MANIFEST_VERSION = 1

export interface Manifest {
  readonly version: number
  readonly projectId: string
  readonly dna: ProjectDna
  readonly writtenAt: number
  /** Traits a human corrected. These outrank a later measurement. */
  readonly humanOverrides?: Readonly<Record<string, { readonly value: string; readonly why: string; readonly by: string }>>
}

export const toManifest = (dna: ProjectDna, writtenAt: number): Manifest => ({
  version: MANIFEST_VERSION,
  projectId: dna.projectId,
  dna,
  writtenAt,
})

export type ManifestAnswer =
  | { readonly kind: "answer"; readonly value: string; readonly confidence: Confidence; readonly evidence: string; readonly ageMs: number }
  | { readonly kind: "unknown"; readonly why: string }

/**
 * Answer a question about the project from the manifest.
 *
 * The answer carries its AGE and its confidence, because a manifest read a
 * month later is a claim about a month ago. An answer that hid its age would
 * make a stale build command indistinguishable from one verified this morning
 * — which is the failure this sprint is meant to prevent, not create.
 *
 * A human override outranks a measurement on purpose: if somebody wrote down
 * that the deploy is not what it looks like, they know something the
 * measurement did not see.
 */
export function askManifest(manifest: Manifest, trait: keyof ProjectDna, now: number): ManifestAnswer {
  const override = manifest.humanOverrides?.[trait as string]
  if (override !== undefined)
    return {
      kind: "answer",
      value: override.value,
      confidence: "declared",
      evidence: `set by ${override.by}: ${override.why}`,
      ageMs: now - manifest.writtenAt,
    }

  const value = manifest.dna[trait]
  if (typeof value === "number" || typeof value === "string")
    return { kind: "unknown", why: `${String(trait)} is not a trait with evidence` }

  const t = value as Trait<unknown>
  if (t === undefined || t.value === undefined || t.confidence === "unknown")
    return { kind: "unknown", why: `${String(trait)} was never established: ${t?.evidence ?? "no record"}` }

  return {
    kind: "answer",
    value: Array.isArray(t.value) ? t.value.join(", ") : String(t.value),
    confidence: t.confidence,
    evidence: t.evidence,
    ageMs: now - t.at,
  }
}

/**
 * Is this manifest too old to act on without re-checking?
 *
 * A threshold rather than a judgement, and a report rather than a refusal: the
 * agent may still use a stale manifest, but it cannot do so without the fact
 * being available to whoever reads the run.
 */
export function staleness(manifest: Manifest, now: number, maxAgeMs = 30 * 24 * 60 * 60 * 1000): { stale: boolean; why: string } {
  const age = now - manifest.writtenAt
  return age > maxAgeMs
    ? {
        stale: true,
        why: `this manifest is ${Math.round(age / (24 * 60 * 60 * 1000))} days old — it is a claim about the project as it was, and projects move`,
      }
    : { stale: false, why: `${Math.round(age / (24 * 60 * 60 * 1000))} days old` }
}
