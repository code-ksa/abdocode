/**
 * CL-16A3-B2C1 §5 — the centralized mutation port for this package.
 *
 * WHY IT EXISTS. `execution-root.ts` and `lifecycle.ts` were exempted from the
 * CL-00A guard AS FILES, which meant every filesystem primitive they might ever
 * contain was permitted in advance — including one added later, by someone who
 * never read the reason the exemption was granted. A file is the wrong unit for
 * that decision. The right unit is the OPERATION.
 *
 * So every mutation those two files perform now goes through a NAMED operation
 * here, and this module is the only holder of the raw primitives in the package's
 * `src/`. Each operation says what it may touch and why it is allowed, and the
 * guard permits the primitives at these exact callsites — not at the file, and
 * not at any new callsite that appears beside them.
 *
 * WHAT THIS PORT IS NOT. It is not a policy decision point and it does not make
 * anything safe on its own: the sequencing law
 *
 *     durable intent -> mutation -> observed OS state -> durable completion
 *
 * lives in the callers, which record the intent and then INSPECT the result
 * through the helper rather than trusting a return code. What this port adds is
 * that the set of mutations is closed, named, and reviewable in one place.
 *
 * DIRECTORY CREATION, DACL APPLICATION AND PUBLICATION ARE NOT HERE. They go
 * through the Rust helper (`create-dir`, `protect-dir`, `publish-dir`) because
 * they need Win32 semantics Node cannot express — atomic no-replace rename,
 * explicit ACE targets, owner-only protected DACLs. Only marker CONTENT and the
 * removal of directories this process owns are Node's work.
 */
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A durable JSON marker written INSIDE a directory this process created and
 * still owns.
 *
 * The two callers are the staging owner stamp and the root marker. Both are
 * written before the directory is published, into a private staging path, and
 * both are re-inspected through the helper afterwards — the write is never the
 * proof.
 */
export function writeOwnedMarkerFile(directory: string, fileName: string, value: unknown): void {
  // [CL-00A:ALLOW windows_controlled_fs_port]
  writeFileSync(join(directory, fileName), JSON.stringify(value, null, 2), "utf8")
}

/**
 * The same, minus the pretty-printing, for the profile ownership marker beside
 * an AppContainer profile directory.
 *
 * Separate from `writeOwnedMarkerFile` because its failure policy is different:
 * the caller deliberately swallows the error, since a profile without a marker
 * is treated as UNOWNED by the sweep — the conservative direction — and must
 * never fail a run.
 */
export function writeCompactMarkerFile(path: string, value: unknown): void {
  // [CL-00A:ALLOW windows_controlled_fs_port]
  writeFileSync(path, JSON.stringify(value), "utf8")
}

/**
 * Remove a directory tree this process is PROVED to own.
 *
 * Every caller has established ownership first, and the two callers differ in
 * how: the discard paths remove a staging directory this process created moments
 * earlier and never published, while the sweep removes one whose owning process
 * has been proved dead by pid AND creation time. Neither ever removes a
 * published root, and no caller passes a path derived from a model.
 *
 * It reports success instead of throwing, because both callers must continue
 * with their real outcome — a refusal, or a sweep of the remaining entries —
 * rather than have it replaced by a cleanup error. `sweepStaleStaging` needs the
 * errno to record WHY a removal was deferred, so it is returned rather than
 * swallowed.
 */
export function removeOwnedDirectoryTree(path: string): { removed: boolean; code?: string } {
  try {
    // [CL-00A:ALLOW windows_controlled_fs_port]
    rmSync(path, { recursive: true, force: true })
    return { removed: true }
  } catch (e) {
    return { removed: false, code: (e as NodeJS.ErrnoException).code ?? "unknown" }
  }
}
