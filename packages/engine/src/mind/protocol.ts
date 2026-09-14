/**
 * Compatibility facade. The authoritative shell contract lives in
 * @abdo/transport-contracts so every carrier and engine handler shares it.
 */
import {
  SHELL_FRAMES,
  shellSdkReference,
  validateShellFrame,
} from "@abdo/transport-contracts"

export type { Direction, FrameSpec, ShellValidation as Validation } from "@abdo/transport-contracts"
export { SHELL_FRAMES, shellSdkReference, validateShellFrame } from "@abdo/transport-contracts"

export const FRAMES = SHELL_FRAMES
export const validate = validateShellFrame
export const sdkReference = shellSdkReference
export const Protocol = { FRAMES, validate, sdkReference }
