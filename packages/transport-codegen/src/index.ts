import { SHELL_FRAMES, type FrameSpec } from "@abdo/transport-contracts/shell-protocol"
const quote = (value: string) => JSON.stringify(value)
export function generateShellReference(frames: readonly FrameSpec[] = SHELL_FRAMES): string {
  const seen = new Set<string>()
  const rows = [...frames].map((frame) => {
    const key = `${frame.dir}:${frame.kind}`
    if (seen.has(key)) throw new Error("duplicate_shell_frame")
    seen.add(key)
    return `  { kind: ${quote(frame.kind)}, direction: ${quote(frame.dir)}, required: ${JSON.stringify(frame.required ?? [])} },`
  })
  return ["// generated from @abdo/transport-contracts; do not edit", "export const shellFrames = [", ...rows, "] as const", ""].join("\n")
}
