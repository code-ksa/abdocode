import { createHash } from "node:crypto"

export type RegistrySource = "builtin" | "owner-config"

export interface RegistryEntry {
  readonly id: string
  readonly version: string
  readonly source: RegistrySource
}

export interface RegistrySnapshot<T extends RegistryEntry> {
  readonly entries: readonly T[]
  readonly digest: string
}

const ID = /^[a-z][a-z0-9-]{0,63}$/

export class DeterministicRegistry<T extends RegistryEntry> {
  readonly #entries = new Map<string, T>()

  register(entry: T): this {
    if (!ID.test(entry.id)) throw new Error(`invalid registry id: ${entry.id}`)
    if (this.#entries.has(entry.id)) throw new Error(`duplicate registry id: ${entry.id}`)
    this.#entries.set(entry.id, Object.freeze({ ...entry }))
    return this
  }

  get(id: string): T | undefined {
    return this.#entries.get(id)
  }

  snapshot(): RegistrySnapshot<T> {
    const entries = [...this.#entries.values()].sort((a, b) => a.id.localeCompare(b.id))
    const canonical = JSON.stringify(entries, Object.keys(entries[0] ?? {}).sort())
    return Object.freeze({
      entries: Object.freeze(entries),
      digest: createHash("sha256").update("abdo-registry-v1\0").update(canonical).digest("hex"),
    })
  }
}
