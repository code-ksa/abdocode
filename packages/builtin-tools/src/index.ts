/**
 * @abdo/builtin-tools — the concrete tools that let V2 do real work.
 *
 * Register them into a ToolRegistry, then the PolicyToolRunner enforces policy,
 * danger detection, approval, redaction, timeout and rollback around them.
 *
 *   const reg = registerBuiltins(new ToolRegistry(), { workspace })
 */
import type { ToolRegistry } from "@abdo/tools"
import { editFileTool, listDirTool, readFileTool, writeFileTool } from "./file-tools"
import { shellTool } from "./shell"
import { runCommandTool } from "./run-command"

export { resolveInWorkspace, PathEscapeError } from "./workspace"
export { readFileTool, listDirTool, writeFileTool, editFileTool, rollbackFromReceipt } from "./file-tools"
export { shellTool } from "./shell"
export { runCommandTool, type RunCommandOutput } from "./run-command"
export {
  gitReadTool,
  gitChangeTool,
  packageInstallTool,
  networkFetchTool,
  guardNetworkUrl,
  registerAdapterTools,
  type AdapterOptions,
  type PackageManager,
  type UrlVerdict,
} from "./adapters"
export { repairCommandSpec, splitCommandLine, type CommandRepair } from "./repair-command"
export { needsShell, validateCommand, toArgv, renderForDisplay, commandDigestInput, type CommandSpec, type CommandProblem } from "./command"
export {
  runRemoteScript,
  sshArgv,
  shellQuotePosix,
  withArgumentPrologue,
  hasNestedQuoting,
  type ExecChannel,
  type SshTarget,
  type TransferReceipt,
} from "./ssh-transport"

export interface BuiltinOptions {
  readonly workspace: string
  /** Include the shell tool (default true). */
  readonly shell?: boolean
}

export function registerBuiltins(registry: ToolRegistry, options: BuiltinOptions): ToolRegistry {
  registry
    .register(readFileTool(options.workspace))
    .register(listDirTool(options.workspace))
    .register(writeFileTool(options.workspace))
    .register(editFileTool(options.workspace))
  // The structured runner is registered ALONGSIDE the shell, not instead of it:
  // a command that genuinely needs pipes or redirection still needs a shell, and
  // pretending otherwise would push callers back into hand-quoting.
  registry.register(runCommandTool(options.workspace))
  if (options.shell !== false) registry.register(shellTool(options.workspace))
  return registry
}
