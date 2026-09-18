/**
 * ProjectIndex — the retrieval ladder.
 *
 * For code, an exact path or symbol name is more precise than semantic
 * similarity, so results are tiered:
 *   1. path    — the query names a file
 *   2. symbol  — the query is an exact symbol (function/class/interface/...)
 *   3. fts     — full-text token overlap, ranked by frequency
 *   (git history and embeddings are future tiers with the same result shape)
 *
 * Every file carries a content hash. Re-indexing an unchanged file is a no-op;
 * changing it bumps its revision and rewrites its symbols/tokens, so a modified
 * file never serves stale results.
 */
import { extractSymbols, type CodeSymbol } from "./symbols"

export type RetrievalTier = "path" | "symbol" | "fts"
export const TIER_ORDER: Record<RetrievalTier, number> = { path: 0, symbol: 1, fts: 2 }

export interface FileEntry {
  readonly path: string
  readonly hash: string
  readonly revision: number
  readonly symbols: readonly CodeSymbol[]
}

export interface SearchResult {
  readonly path: string
  readonly tier: RetrievalTier
  readonly score: number
  readonly symbol?: CodeSymbol
}

/** FNV-1a content hash — stable, cheap, non-cryptographic. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// الحروفُ كلُّها لا اللاتينيّة وحدها (09-16): الهدفُ يُكتب عربيّاً ووثائقُ المشروع عربيّة، فكان
// الاسترجاعُ النصّيّ أعمى عنهما. التشكيلُ والتطويلُ يُسقَطان وألفاتُ الهمزة تُوحَّد قبل المطابقة.
const ARABIC_MARKS = new RegExp(`[${String.fromCharCode(0x064b)}-${String.fromCharCode(0x0652)}${String.fromCharCode(0x0640)}]`, "gu")
const ALEF_FORMS = new RegExp(`[${String.fromCharCode(0x0622)}${String.fromCharCode(0x0623)}${String.fromCharCode(0x0625)}]`, "gu")
const ALEF = String.fromCharCode(0x0627)
const tokenize = (text: string): string[] =>
  (text.toLowerCase().replace(ARABIC_MARKS, "").replace(ALEF_FORMS, ALEF).match(/[\p{L}\p{N}_]{2,}/gu) ?? [])
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path
const stripExt = (name: string): string => name.replace(/\.[^.]+$/, "")

export class ProjectIndex {
  private readonly files = new Map<string, FileEntry>()
  /** symbol name -> set of paths declaring it. */
  private readonly symbolIndex = new Map<string, Set<string>>()
  /** token -> path -> count. */
  private readonly tokenIndex = new Map<string, Map<string, number>>()

  /** Add or update a file. Unchanged content (same hash) is a no-op. */
  upsert(path: string, content: string): FileEntry {
    const h = hash(content)
    const existing = this.files.get(path)
    if (existing && existing.hash === h) return existing // stale-index guard

    if (existing) this.forget(path) // clear old symbols/tokens before reindex

    const symbols = extractSymbols(content)
    const entry: FileEntry = { path, hash: h, revision: (existing?.revision ?? 0) + 1, symbols }
    this.files.set(path, entry)

    for (const s of symbols) {
      let set = this.symbolIndex.get(s.name)
      if (!set) this.symbolIndex.set(s.name, (set = new Set()))
      set.add(path)
    }
    for (const tok of tokenize(content)) {
      let counts = this.tokenIndex.get(tok)
      if (!counts) this.tokenIndex.set(tok, (counts = new Map()))
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    return entry
  }

  remove(path: string): void {
    if (this.files.has(path)) this.forget(path)
    this.files.delete(path)
  }

  get(path: string): FileEntry | undefined {
    return this.files.get(path)
  }

  /** True if the given content differs from what is indexed for `path`. */
  isStale(path: string, content: string): boolean {
    const entry = this.files.get(path)
    return !entry || entry.hash !== hash(content)
  }

  // --- individual tiers ---------------------------------------------------

  lookupPath(query: string): string[] {
    return [...this.files.keys()].filter(
      (p) => p === query || basename(p) === query || stripExt(basename(p)) === query || p.endsWith("/" + query),
    )
  }

  lookupSymbol(name: string): SearchResult[] {
    const paths = this.symbolIndex.get(name)
    if (!paths) return []
    const out: SearchResult[] = []
    for (const path of paths) {
      const symbol = this.files.get(path)?.symbols.find((s) => s.name === name)
      out.push({ path, tier: "symbol", score: 1, symbol })
    }
    return out
  }

  fullText(query: string): SearchResult[] {
    const scores = new Map<string, number>()
    for (const tok of tokenize(query)) {
      const counts = this.tokenIndex.get(tok)
      if (!counts) continue
      for (const [path, count] of counts) scores.set(path, (scores.get(path) ?? 0) + count)
    }
    return [...scores.entries()]
      .map(([path, score]) => ({ path, tier: "fts" as const, score }))
      .sort((a, b) => b.score - a.score)
  }

  // --- combined ladder ----------------------------------------------------

  /** Run the ladder and return results ordered by tier, then score. */
  search(query: string, limit = 20): SearchResult[] {
    const results: SearchResult[] = [
      ...this.lookupPath(query).map((path) => ({ path, tier: "path" as const, score: 1 })),
      ...this.lookupSymbol(query),
      ...this.fullText(query),
    ]
    return results
      .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score)
      .slice(0, limit)
  }

  get size(): number {
    return this.files.size
  }

  private forget(path: string): void {
    const entry = this.files.get(path)
    if (!entry) return
    for (const s of entry.symbols) {
      const set = this.symbolIndex.get(s.name)
      if (set) {
        set.delete(path)
        if (set.size === 0) this.symbolIndex.delete(s.name)
      }
    }
    for (const [tok, counts] of this.tokenIndex) {
      if (counts.delete(path) && counts.size === 0) this.tokenIndex.delete(tok)
    }
  }
}
