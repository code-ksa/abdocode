import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { isInside, protectedPathVerdict } from "./protected-paths"

/** Project selection is separate from the executable's working directory. */
export function projectPathProblem(path: string, blockedRoots: readonly string[], create = false): string | undefined {
  if (!isAbsolute(path) || /[\u0000-\u001f]/u.test(path)) return "Use an absolute project folder path."
  const absolute = resolve(path)
  if (dirname(absolute) === absolute) return "A filesystem root cannot be a project."
  if (blockedRoots.some(root => isInside(absolute, root) || isInside(root, absolute))) return "The application installation and private state cannot be used as a project."
  const shield = protectedPathVerdict(absolute, absolute, process.env)
  if (!shield.allowed) return `Protected project location: ${shield.why}`
  if (create && existsSync(absolute) && !isEmptyDirectory(absolute)) return "The target already exists. Select it using Open project; creation never overwrites an existing folder."
  if (!create && (!existsSync(absolute) || !statSync(absolute).isDirectory())) return "The project folder does not exist."
  // Refuse a junction/symlink at any component, including a non-existent child
  // underneath a junction. Recheck after approval before the single mkdir.
  for (let item = absolute; ; item = dirname(item)) {
    if (existsSync(item) && lstatSync(item).isSymbolicLink()) return "Choose a project path without symbolic links or junctions."
    if (dirname(item) === item) break
  }
  if (create && (!existsSync(dirname(absolute)) || !statSync(dirname(absolute)).isDirectory())) return "The parent folder must already exist."
  return undefined
}

/** مجلّدٌ موجودٌ وفارغ (مقيس 2026-09-13: النموذج أنشأه بـNew-Item قبل project-create فصار المشروعُ «-2» بجانبه) يُتبنّى لا يُكرَّر. */
export function isEmptyDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() && readdirSync(path).length === 0 } catch { return false }
}

export function createProjectFolder(path: string, blockedRoots: readonly string[]): string {
  const problem = projectPathProblem(path, blockedRoots, true)
  if (problem) throw new Error(problem)
  if (!isEmptyDirectory(resolve(path))) mkdirSync(resolve(path)) // exclusive: EEXIST is a failure, not a successful create — إلا الفارغَ فيُتبنّى
  const actual = realpathSync(path)
  if (projectPathProblem(actual, blockedRoots)) throw new Error("The created project path changed unexpectedly.")
  // مراجعة 09-14 (#17): فجوةُ TOCTOU في تبنّي المجلّد الفارغ — يُقاس مرّةً ثانية لحظةَ التبنّي؛ ما امتلأ بينهما لا يُتبنّى.
  if (!isEmptyDirectory(actual)) throw new Error("The folder was filled by someone else between the check and the adoption; choose another name or open it with Open project.")
  return actual
}

/** The OS supplies Documents (including redirected/OneDrive locations). The
 * model chooses the project name; no developer or machine-specific path exists. */
export function resolveNewProjectTarget(input: string, documents: string | undefined): string {
  const value = input.trim().replace(/^"(.*)"$/u, "$1")
  if (isAbsolute(value)) return resolve(value)
  if (!documents || !isAbsolute(documents) || !existsSync(documents)) throw new Error("Choose an absolute project location; the Documents folder is unavailable.")
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)) throw new Error("Provide a project folder name or an absolute location, without traversal or reserved names.")
  for(let suffix=0;suffix<1000;suffix++) {
    const path=join(documents,value+(suffix ? `-${suffix+1}` : ""))
    if(!existsSync(path) || (suffix === 0 && isEmptyDirectory(path))) return path
  }
  throw new Error("Choose another project name; too many folders already use this name.")
}

export function projectBootstrapInstruction(project: string, selected: boolean, coaching = true): string {
  // الرفيع (أمر 09-06): الجذرُ وقاعدةُ الاسم فقط — لا وصفةَ Next ولا قاعدةَ SQLite.
  if (selected && !coaching) return `\nActive project root: ${project}. Write all project files in this root. The package name must begin with ${basename(project).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.\n`
  return selected
    ? `\nActive project root: ${project}. Before changing dependencies use project-inspect, then read the framework configuration and relevant source. Preserve the existing package manager and compatible dependency relationships. Write all project files in this root. The package name must begin with ${basename(project).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}. For a new Next.js scaffold, first write a minimal manifest with next/react/react-dom and TypeScript only (when the user named Vite: vite/@vitejs/plugin-react/react/react-dom/react-router-dom; Tailwind only when the user asked for it — the manifest guard follows the stack the user named); after the initial build, add the requested database dependencies and implement the database. SQLite is the default only when the user did not choose PostgreSQL, MariaDB, or another database.\n`
    : "\nNO PROJECT IS SELECTED. The installation directory is not a project. For a requested starter use templates to compare matching stacks, then project-template with the chosen id and folder name during implementation. For an empty project use project-create. In full-access mode, choose a suitable ASCII English project folder name (lowercase words separated by hyphens) and call project-create with that name: the application resolves the current user's actual Documents folder and avoids name collisions. If the user specified another location, use their absolute path instead. In other modes ask where to create the project or present the proposed location for approval. Always tell the user the actual created path from the receipt. This creates only an empty folder and binds it to this session; then write the sprint plan and implement it yourself. For an existing project the user names (continue, open, finish project X), call project-locate with that name, then project-open with the chosen absolute path; it returns the orientation. Never invent a machine-specific user path.\n"
}
