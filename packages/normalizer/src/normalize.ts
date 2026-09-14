/**
 * Shell-dispatching entry point. Stage 1 supports bash; anything else is
 * honestly `uncertain` — an unsupported shell is an unknown, and an unknown
 * escalates. It never falls back to "probably fine".
 */
import type { NormalizedOperation } from "@abdo/control-contracts"
import { normalizeBash } from "./bash"
import { normalizeWindows } from "./windows"

export interface NormalizeOptions {
  readonly shell?: "bash" | "powershell" | "cmd"
  readonly cwd?: string
}

export function normalize(command: string, options: NormalizeOptions = {}): NormalizedOperation {
  const shell = options.shell ?? "bash"
  if (shell === "bash") return normalizeBash(command, { cwd: options.cwd })
  if (shell === "powershell" || shell === "cmd") return normalizeWindows(command, shell, { cwd: options.cwd })
  return {
    kind: "shell",
    shell,
    summary: `${shell}: ${command.slice(0, 120)}`,
    certainty: "uncertain",
    commands: [],
    cwd: options.cwd ?? "",
    unknownDynamicSegments: [command],
    uncertainReasons: ["shell_not_yet_normalized"],
    resources: { analysis: "unknown" },
  }
}
