/** Finding an existing project by the name the user says.
 *
 * "استكمل مشروع رودود" / "continue project rodud" names a folder, not a path.
 * The locator scans the user's project roots (Documents, configured roots,
 * the siblings of the selected project) two levels deep, bounded, and ranks
 * folders by how their name matches the spoken name — across scripts, so an
 * Arabic name finds a Latin folder by consonant skeleton (رودود ↔ rodud).
 *
 * It only observes: nothing is selected, created or read beyond directory
 * metadata. Folder names are data, never instructions. */
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { words } from "@abdo/semantic"

export interface ProjectCandidate {
  readonly path: string
  readonly name: string
  readonly score: number
  readonly matched: readonly string[]
  readonly signals: {
    readonly git: boolean
    readonly packageJson: boolean
    readonly plans: readonly string[]
    readonly awareness: boolean
    readonly modified?: string
  }
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "out", "tmp", ".cache", "coverage", "vendor", "__pycache__", ".venv", "venv", ".turbo", "payload", "release", "debug"])
const PLAN_FILES = ["PLAN.md", "ABDO-SPRINTS.md", "ABDO-HANDOFF.md", "NEXT_ACTION.md", "TASKS.md", "TODO.md"]
const MAX_ENTRIES = 600
const MAX_RESULTS = 8

const ARABIC_LATIN: Readonly<Record<string, string>> = Object.freeze({
  "ا": "a", "أ": "a", "إ": "a", "آ": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh", "د": "d", "ذ": "th",
  "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q",
  "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "h", "و": "w", "ي": "y", "ى": "a", "ئ": "a", "ؤ": "w", "ء": "",
})

/**
 * كلماتُ الاسم بطيّ الرسم — **من `@abdo/semantic` لا من نسخةٍ محلّية** (د5، 2026-09-06): كان هنا طيٌّ خاصّ
 * (تشكيل/تطويل/همزات/ة/ى) يوازي `fold` ناقصَ ؤ/ئ/ٱ والأرقامَ الهندية؛ نسختان لشيءٍ واحد تتباعدان بصمت.
 * الاسمُ يبقى للمستوردين، والسلوكُ الأوسع مقصود: «مؤسسة» تجد «موسسه».
 */
export function nameTokens(text: string): string[] {
  return words(text)
}

/** Consonant skeleton across scripts: rodud → rdd, رودود → rdd, mosaiden → msdn, مساعدين → msadn→msdn. */
export function skeleton(token: string): string {
  const latin = [...token].map((ch) => ARABIC_LATIN[ch] ?? ch).join("")
  return latin.replace(/[^a-z0-9]/gu, "").replace(/[aeiouwy]/gu, "")
}

const STOP = new Set(["مشروع", "المشروع", "project", "the", "folder", "مجلد", "app", "site", "موقع", "تطبيق"])

function scoreName(folder: string, wanted: readonly string[]): { score: number; matched: string[] } {
  const have = nameTokens(folder)
  const joined = have.join("")
  const haveSkeletons = have.map(skeleton)
  const joinedSkeleton = skeleton(joined)
  let score = 0
  const matched: string[] = []
  for (const token of wanted) {
    if (STOP.has(token) || token.length < 2) continue
    const wantSkeleton = skeleton(token)
    if (have.includes(token) || joined === token) { score += 4; matched.push(token); continue }
    if (wantSkeleton.length >= 2 && (haveSkeletons.includes(wantSkeleton) || joinedSkeleton === wantSkeleton)) { score += 3; matched.push(token); continue }
    if (token.length >= 3 && (joined.includes(token) || have.some((h) => h.startsWith(token) || token.startsWith(h) && h.length >= 3))) { score += 2; matched.push(token); continue }
    if (wantSkeleton.length >= 3 && joinedSkeleton.includes(wantSkeleton)) { score += 1; matched.push(token) }
  }
  // A folder whose every word was named outranks one that also carries extra words (rodud > rodud-mobile).
  if (score > 0 && have.length > 0) {
    const named = wanted.filter((token) => !STOP.has(token))
    const covered = have.filter((h) => named.some((w) => w === h || (skeleton(w).length >= 2 && skeleton(w) === skeleton(h)) || (w.length >= 3 && h.length >= 3 && (h.startsWith(w) || w.startsWith(h)))))
    if (covered.length === have.length) score += 1
  }
  return { score, matched }
}

function signalsOf(path: string): ProjectCandidate["signals"] {
  const has = (name: string) => { try { return existsSync(join(path, name)) } catch { return false } }
  let modified: string | undefined
  try { modified = statSync(path).mtime.toISOString() } catch {}
  return { git: has(".git"), packageJson: has("package.json"), plans: PLAN_FILES.filter(has), awareness: has("ABDO-AWARENESS.md"), ...(modified ? { modified } : {}) }
}

function childDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
  } catch { return [] }
}

/** Roots worth scanning for this user: explicit roots, Documents, the selected project's parent. */
export function defaultProjectRoots(input: { documents?: string; configured?: readonly string[]; selectedProject?: string }): string[] {
  const roots: string[] = []
  const push = (value: string | undefined) => { if (value && isAbsolute(value)) { const r = resolve(value); if (!roots.includes(r)) roots.push(r) } }
  for (const configured of input.configured ?? []) push(configured)
  push(input.documents)
  if (input.selectedProject && isAbsolute(input.selectedProject)) push(dirname(resolve(input.selectedProject)))
  return roots.filter((root) => { try { return lstatSync(root).isDirectory() } catch { return false } })
}

/** Rank existing folders under the roots by the spoken name. Bounded scan, no reads beyond metadata. */
export function locateProjects(query: string, roots: readonly string[], limit = MAX_RESULTS): { candidates: ProjectCandidate[]; scanned: number; roots: string[]; truncated: boolean } {
  const trimmed = query.trim().replace(/^"(.*)"$/u, "$1")
  const validRoots = roots.filter((root) => isAbsolute(root)).map((root) => resolve(root))
  if (trimmed && isAbsolute(trimmed)) {
    const path = resolve(trimmed)
    let isDir = false
    try { isDir = lstatSync(path).isDirectory() } catch {}
    return { candidates: isDir ? [{ path, name: basename(path), score: 10, matched: ["path"], signals: signalsOf(path) }] : [], scanned: isDir ? 1 : 0, roots: validRoots, truncated: false }
  }
  const wanted = nameTokens(trimmed)
  const seen = new Set<string>()
  const candidates: ProjectCandidate[] = []
  let scanned = 0, truncated = false
  const consider = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    scanned++
    const { score, matched } = scoreName(basename(path), wanted)
    if (score > 0) candidates.push({ path, name: basename(path), score, matched, signals: signalsOf(path) })
  }
  outer: for (const root of validRoots) {
    for (const child of childDirs(root)) {
      if (scanned >= MAX_ENTRIES) { truncated = true; break outer }
      consider(child)
      // One level deeper for container folders (projects/, work/, repos/ …), still bounded.
      for (const grandchild of childDirs(child)) {
        if (scanned >= MAX_ENTRIES) { truncated = true; break outer }
        consider(grandchild)
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score
    || Number(b.signals.git) - Number(a.signals.git)
    || (b.signals.modified ?? "").localeCompare(a.signals.modified ?? ""))
  return { candidates: candidates.slice(0, limit), scanned, roots: validRoots, truncated }
}
