/**
 * CL-05 — argument-level resource analysis.
 *
 * Moved here from CL-04, which could only see redirections. The rule that
 * carries over unchanged: **an absent field means "we did not determine it",
 * never "there is nothing"**. `analysis` is the field to read first, and empty
 * arrays are never emitted to stand in for unfilled work — that is exactly how a
 * destructive command comes to look inert.
 *
 * `complete` is claimed only when EVERY command was recognised, every path
 * argument was literal, and the parse itself was certain. A glob, a variable, an
 * unknown program, or an unparsed operation all keep it below `complete` — which
 * in turn keeps the risk elevated.
 */
import type { Capability, NormalizedCommand, NormalizedOperation, ResourceAnalysis } from "@abdo/control-contracts"
import { classifyCapability, firstArgument } from "./capability"

/** A glob or a variable means the path is not knowable statically. */
const NOT_LITERAL = /[?*[\]]|\$|%[A-Za-z_]|~/

const READ_CAPS = new Set<Capability>(["filesystem.read", "git.read", "database.read", "kubernetes.read", "cloud.read", "system.read", "secret.read"])
const WRITE_CAPS = new Set<Capability>(["filesystem.write", "filesystem.delete", "filesystem.permission", "secret.write"])

/** Programs whose FIRST argument is a subcommand, not a path. */
const SUBCOMMAND_PROGRAMS = new Set(["git", "docker", "kubectl", "npm", "pnpm", "yarn", "bun", "pip", "cargo", "aws", "gcloud", "az", "systemctl", "go", "helm"])

/** Host-ish argument of a network command, for `networkHints`. */
function networkTargets(command: NormalizedCommand): string[] {
  const out: string[] = []
  for (const a of command.argv) {
    if (a.startsWith("-")) continue
    const url = /^(https?|ftp|git|ssh):\/\/([^/\s]+)/i.exec(a)
    if (url) {
      out.push(url[2]!)
      continue
    }
    // `user@host:path` (ssh/scp) and bare hostnames with a dot.
    const at = /^[^@\s]+@([^:\s]+)/.exec(a)
    if (at) {
      out.push(at[1]!)
      continue
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(a)) out.push(a)
  }
  return out
}

/** Path-looking arguments: not flags, not the subcommand, not a URL. */
function pathArguments(command: NormalizedCommand): { literal: string[]; hadNonLiteral: boolean } {
  const literal: string[] = []
  let hadNonLiteral = false
  const sub = SUBCOMMAND_PROGRAMS.has(command.program) ? firstArgument(command.argv) : undefined
  for (const a of command.argv) {
    if (a.startsWith("-")) continue
    if (/^\/[A-Za-z?]/.test(a) && command.argv.some((x) => x.startsWith("/"))) continue // cmd-style flag
    if (a === sub) continue
    if (/^[a-z]+:\/\//i.test(a)) continue // a URL is a network target, not a path
    if (NOT_LITERAL.test(a)) {
      hadNonLiteral = true
      continue
    }
    literal.push(a)
  }
  return { literal, hadNonLiteral }
}

/**
 * Analyse what an operation reads, writes and reaches over the network.
 * Redirections are still counted; arguments are now counted too.
 */
export function analyzeResources(operation: NormalizedOperation): ResourceAnalysis {
  const commands = operation.commands ?? []
  const reads = new Set<string>()
  const writes = new Set<string>()
  const network = new Set<string>()
  let incomplete = operation.certainty === "uncertain" || commands.length === 0

  for (const c of commands) {
    for (const r of c.redirections) {
      if (NOT_LITERAL.test(r.target)) incomplete = true
      else if (r.kind === "in") reads.add(r.target)
      else writes.add(r.target)
    }
    const { capability, confidence } = classifyCapability(c)
    if (confidence === "unknown") {
      incomplete = true
      continue
    }
    const { literal, hadNonLiteral } = pathArguments(c)
    if (hadNonLiteral) incomplete = true
    if (READ_CAPS.has(capability)) for (const p of literal) reads.add(p)
    else if (WRITE_CAPS.has(capability)) for (const p of literal) writes.add(p)
    else if (literal.length > 0) incomplete = true // we saw paths but cannot say which way
    const hosts = networkTargets(c)
    for (const h of hosts) network.add(h)
    // A package install or a network capability reaches hosts we cannot name.
    if (!hosts.length && (capability.startsWith("network.") || capability.startsWith("package.install") || capability.startsWith("package.update"))) {
      incomplete = true
    }
  }

  const anything = reads.size > 0 || writes.size > 0 || network.size > 0
  const analysis: ResourceAnalysis["analysis"] = incomplete ? (anything ? "partial" : "unknown") : "complete"
  return {
    analysis,
    // Fields are OMITTED when empty: an absent `writes` says "not determined",
    // an empty array would say "writes nothing", and those are different claims.
    ...(reads.size > 0 ? { reads: [...reads] } : {}),
    ...(writes.size > 0 ? { writes: [...writes] } : {}),
    ...(network.size > 0 ? { networkHints: [...network] } : {}),
  }
}
