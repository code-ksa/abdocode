/**
 * Lightweight symbol extraction for TS/JS.
 *
 * Regex-based on purpose: fast, dependency-free, good enough to power the
 * "exact symbol" retrieval tier. A real AST/LSP tier can slot in later without
 * changing the retrieval contract — it just produces the same CodeSymbol[].
 */

export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "enum"

export interface CodeSymbol {
  readonly name: string
  readonly kind: SymbolKind
  readonly line: number
}

const RULES: ReadonlyArray<readonly [SymbolKind, RegExp]> = [
  ["function", /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g],
  ["class", /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g],
  ["interface", /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g],
  ["type", /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/g],
  ["enum", /(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g],
  ["const", /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g],
]

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

export function extractSymbols(content: string): CodeSymbol[] {
  const out: CodeSymbol[] = []
  const seen = new Set<string>()
  for (const [kind, re] of RULES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!
      const key = `${kind}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      // m.index sits at the leading newline; anchor the line on the name itself.
      const nameStart = m.index + m[0].lastIndexOf(name)
      out.push({ name, kind, line: lineOf(content, nameStart) })
    }
  }
  return out
}
