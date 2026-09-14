/**
 * @abdo/normalizer — CL-04. Pure command normalization: no execution, no IO.
 *
 * Stage 1: Bash. Stage 2: PowerShell and cmd.exe — same contract, same
 * fail-closed rule, different syntax (backtick/`^` escapes, `$env:`/`%VAR%`
 * expansion, Windows paths). An unknown shell is still `uncertain`, never guessed.
 */
export { normalizeBash, type BashNormalizeOptions } from "./bash"
export { normalizeWindows, type WindowsShell } from "./windows"
export { normalize, type NormalizeOptions } from "./normalize"
