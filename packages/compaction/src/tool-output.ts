/**
 * Tool-output pruning. A tool result the next turn needs is NEVER dropped. Large
 * or stale outputs are classified and, when big, externalized to an artifact
 * reference (`tool-output://<executionId>`) so the context keeps a short,
 * useful stub (status + a relevant excerpt) instead of a wall of text.
 */

export type ToolOutputClass = "protected" | "recent" | "summarizable" | "discardable" | "externalized"

export interface ToolOutputInfo {
  readonly executionId: string
  readonly bytes: number
  /** Turns since this output was produced (0 = this turn). */
  readonly ageTurns: number
  /** The next turn consumes this result (e.g. an unfinished tool cycle). */
  readonly neededNextTurn: boolean
  /** Still-open tool call. */
  readonly pending: boolean
}

export interface ClassifyOptions {
  /** Outputs this recent are kept verbatim. Default 2. */
  readonly recentTurns?: number
  /** Outputs at/over this size are externalized instead of inlined. Default 8 KB. */
  readonly externalizeBytes?: number
  /** Beyond this age a summarizable output becomes discardable. Default 12. */
  readonly discardAfterTurns?: number
}

export function classifyToolOutput(info: ToolOutputInfo, options: ClassifyOptions = {}): ToolOutputClass {
  const recentTurns = options.recentTurns ?? 2
  const externalizeBytes = options.externalizeBytes ?? 8 * 1024
  const discardAfterTurns = options.discardAfterTurns ?? 12

  if (info.pending || info.neededNextTurn) return "protected"
  if (info.ageTurns <= recentTurns) return "recent"
  if (info.bytes >= externalizeBytes) return "externalized"
  if (info.ageTurns > discardAfterTurns) return "discardable"
  return "summarizable"
}

export interface ArtifactRef {
  readonly ref: string
  readonly hash: string
  readonly bytes: number
}

/** Where full externalized outputs live. The host supplies a durable adapter. */
export interface ArtifactStore {
  put(executionId: string, content: string): Promise<ArtifactRef>
  get(ref: string): Promise<string | null>
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly data = new Map<string, string>()
  async put(executionId: string, content: string): Promise<ArtifactRef> {
    const ref = `tool-output://${executionId}`
    this.data.set(ref, content)
    return { ref, hash: fnv1a(content), bytes: byteLen(content) }
  }
  async get(ref: string): Promise<string | null> {
    return this.data.get(ref) ?? null
  }
}

export interface ExternalizedStub {
  readonly ref: ArtifactRef
  /** The short text that goes into the context in place of the full output. */
  readonly stub: string
}

/**
 * Store the full output and return a compact context stub. `excerpt` should be
 * the caller's best-effort relevant slice (e.g. the failing lines); we cap it.
 */
export async function externalize(
  store: ArtifactStore,
  info: { executionId: string; output: string; status?: string; excerpt?: string },
  excerptMax = 500,
): Promise<ExternalizedStub> {
  const ref = await store.put(info.executionId, info.output)
  const status = info.status ?? `output ${ref.bytes} bytes`
  const excerpt = (info.excerpt ?? "").slice(0, excerptMax)
  const stub = [status, `Full output stored at ${ref.ref} (${ref.bytes} bytes, hash ${ref.hash}).`, excerpt ? `Relevant:\n${excerpt}` : ""]
    .filter((s) => s.length > 0)
    .join("\n")
  return { ref, stub }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
