/**
 * The symbol graph (Sprint 39) and reference-safe editing (Sprint 41).
 *
 * The graph is built from what the language server actually answered, and it
 * records where every edge came from. That provenance is the whole point: the
 * question this sprint exists to answer is not "how many references are there"
 * but "why does the text search find a different number", and a graph that has
 * forgotten which tool produced which edge cannot answer it.
 *
 * The rule for Sprint 41 follows from that. A deletion is refused while the
 * text search sees occurrences the language server does not explain — not
 * because grep is right, but because a difference nobody explained is a
 * difference nobody understands, and the usual cause is a dynamic reference,
 * a re-export, a string in a config, or a second symbol of the same name. Each
 * of those is a real reason to stop.
 */
import type { LspLocation } from "./client"

export type EdgeKind = "definition" | "reference" | "call" | "import" | "export"

export interface SymbolNode {
  readonly id: string
  readonly name: string
  readonly uri: string
  readonly kind: string
  /** Which package/module the symbol lives in, when known. */
  readonly container?: string
}

export interface SymbolEdge {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  readonly at: LspLocation
  /** Which tool produced this edge. An edge with no provenance is not evidence. */
  readonly source: "lsp" | "text"
}

export interface SymbolGraph {
  readonly nodes: readonly SymbolNode[]
  readonly edges: readonly SymbolEdge[]
  /** Files the graph could NOT cover, and why. Never an empty silence. */
  readonly gaps: readonly { readonly uri: string; readonly why: string }[]
}

export const emptyGraph = (): SymbolGraph => ({ nodes: [], edges: [], gaps: [] })

export function addNode(graph: SymbolGraph, node: SymbolNode): SymbolGraph {
  if (graph.nodes.some((n) => n.id === node.id)) return graph
  return { ...graph, nodes: [...graph.nodes, node] }
}

export function addEdge(graph: SymbolGraph, edge: SymbolEdge): SymbolGraph {
  return { ...graph, edges: [...graph.edges, edge] }
}

export function addGap(graph: SymbolGraph, uri: string, why: string): SymbolGraph {
  return { ...graph, gaps: [...graph.gaps, { uri, why }] }
}

/** Everything that points AT this symbol, by edge kind. */
export function referencesTo(graph: SymbolGraph, symbolId: string, kinds?: readonly EdgeKind[]): SymbolEdge[] {
  return graph.edges.filter((e) => e.to === symbolId && (kinds === undefined || kinds.includes(e.kind)))
}

/** Everything this symbol points at — what breaks if the symbol changes shape. */
export function dependenciesOf(graph: SymbolGraph, symbolId: string): SymbolEdge[] {
  return graph.edges.filter((e) => e.from === symbolId)
}

/**
 * Files reached from a set of changed symbols, transitively.
 *
 * Bounded by `maxDepth`, and the bound is REPORTED: an impact analysis that
 * silently stopped two hops short is more dangerous than one that admits it
 * only looked two hops, because the caller would act on the smaller number.
 */
export function impactedFiles(
  graph: SymbolGraph,
  changed: readonly string[],
  maxDepth = 5,
): { files: string[]; truncated: boolean; depthReached: number } {
  const seen = new Set(changed)
  let frontier = [...changed]
  let depth = 0
  let truncated = false

  while (frontier.length > 0) {
    if (depth >= maxDepth) {
      truncated = frontier.length > 0
      break
    }
    const next: string[] = []
    for (const edge of graph.edges) {
      if (!frontier.includes(edge.to)) continue
      if (seen.has(edge.from)) continue
      seen.add(edge.from)
      next.push(edge.from)
    }
    if (next.length === 0) break
    frontier = next
    depth++
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const files = [...new Set([...seen].map((id) => byId.get(id)?.uri).filter((u): u is string => u !== undefined))].sort()
  return { files, truncated, depthReached: depth }
}

// --------------------------------------------------------------------------
// Sprint 41 — reference-safe deletion and rename
// --------------------------------------------------------------------------

export interface TextMatch {
  readonly uri: string
  readonly line: number
  readonly text: string
}

export interface SafetyVerdict {
  readonly allowed: boolean
  readonly lspReferences: number
  readonly textMatches: number
  /** Occurrences the text search found and the language server did not explain. */
  readonly unexplained: readonly TextMatch[]
  readonly why: string
}

/** A text hit that is genuinely not a reference, and can be discounted by rule. */
const isDiscountable = (match: TextMatch): boolean => {
  const line = match.text.trim()
  return (
    line.startsWith("//") ||
    line.startsWith("*") ||
    line.startsWith("#") ||
    // a same-line comment mentioning the name is not a use of it
    /^\s*\/\*/.test(line)
  )
}

/**
 * May this symbol be deleted or renamed?
 *
 * The comparison is the safeguard. Twelve references and fifteen text matches
 * means three occurrences nobody has accounted for, and every likely cause —
 * a dynamic call, a re-export, a name in a config string, a different symbol
 * with the same name — is a reason to stop rather than a rounding error.
 *
 * Comments are discounted BY RULE and the rule is stated, so a caller can see
 * exactly which occurrences were waved through and disagree.
 */
export function safeToRemove(
  lspReferences: readonly LspLocation[] | undefined,
  textMatches: readonly TextMatch[],
): SafetyVerdict {
  if (lspReferences === undefined) {
    return {
      allowed: false,
      lspReferences: 0,
      textMatches: textMatches.length,
      unexplained: textMatches,
      why: "the language server could not answer, so nothing is known about the references — a text search is not a substitute for one",
    }
  }

  const explained = new Set(lspReferences.map((r) => `${r.uri}:${r.range.start.line}`))
  const unexplained = textMatches.filter((m) => !explained.has(`${m.uri}:${m.line}`) && !isDiscountable(m))

  if (unexplained.length > 0) {
    return {
      allowed: false,
      lspReferences: lspReferences.length,
      textMatches: textMatches.length,
      unexplained,
      why:
        `${lspReferences.length} reference(s) but ${textMatches.length} text match(es): ` +
        `${unexplained.length} occurrence(s) the language server does not explain ` +
        `(${unexplained.slice(0, 3).map((m) => `${m.uri}:${m.line}`).join(", ")}). ` +
        `A dynamic call, a re-export or a name in a config string all look exactly like this.`,
    }
  }

  return {
    allowed: true,
    lspReferences: lspReferences.length,
    textMatches: textMatches.length,
    unexplained: [],
    why: `every one of the ${textMatches.length} text match(es) is accounted for by the reference list or is a comment`,
  }
}
