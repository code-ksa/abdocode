import { parse, type Profile } from "../harness-profile"
import { document as abdoNative } from "./abdo-native"
import { document as claudeStyle } from "./claude-style"
import { document as codexStyle } from "./codex-style"
import { document as deepseekStyle } from "./deepseek-style"
import { document as qwenStyle } from "./qwen-style"

/**
 * The harness registry.
 *
 * The only thing adding a harness costs is a line here and a file next to this
 * one. There is deliberately no switch, no per-id function, and no provider
 * name: the loader folds the list, and everything after it reads fields.
 *
 * Every document is validated at module load. An invalid profile therefore
 * fails at import, which is as far from the network as it is possible to get —
 * the process does not reach the point of having a request to send.
 */
const DOCUMENTS: readonly unknown[] = [abdoNative, claudeStyle, codexStyle, deepseekStyle, qwenStyle]

const load = (documents: readonly unknown[]) => {
  const byId = new Map<string, Profile>()
  for (const candidate of documents) {
    const result = parse(candidate)
    if (!result.ok) {
      // Loud at load. A harness that silently drops out of the registry is a
      // request that quietly goes out with somebody else's instructions.
      throw new Error(`invalid harness profile: ${result.why}`)
    }
    const id = result.profile.document.id
    if (byId.has(id)) throw new Error(`two harness profiles claim the id ${id}`)
    byId.set(id, result.profile)
  }
  return byId
}

const registry = load(DOCUMENTS)

export const ids = (): readonly string[] => [...registry.keys()].sort()

export const get = (id: string): Profile | undefined => registry.get(id)

/** Rebuild a registry from arbitrary documents. Used by tests and by S126's packs. */
export const from = load

export * as HarnessRegistry from "./index"
