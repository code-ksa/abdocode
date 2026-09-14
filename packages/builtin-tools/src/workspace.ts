/**
 * Workspace confinement — every file tool must stay inside the workspace root.
 *
 * Blocks path traversal (`../`), absolute escapes, and symlinks that resolve
 * outside the root. This is the hard boundary that lets a file tool run without
 * per-call approval.
 */
import { existsSync, realpathSync } from "fs"
import { isAbsolute, relative, resolve } from "path"

export class PathEscapeError extends Error {
  constructor(readonly path: string) {
    super(`path escapes the workspace: ${path}`)
    this.name = "PathEscapeError"
  }
}

/** Resolve `p` under `workspace`, throwing if it escapes (incl. via symlink). */
export function resolveInWorkspace(workspace: string, p: string): string {
  const root = realpathSync(workspace)
  const abs = resolve(root, p)
  assertInside(root, abs, p)

  // If the path (or its nearest existing ancestor) is a symlink, follow it and
  // re-check — a symlink inside the root must not point outside it.
  let probe = abs
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..")
    if (parent === probe) break
    probe = parent
  }
  if (existsSync(probe)) {
    const real = realpathSync(probe)
    assertInside(root, real, p)
  }
  return abs
}

function assertInside(root: string, abs: string, original: string): void {
  const rel = relative(root, abs)
  if (rel === "" ) return
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PathEscapeError(original)
}
