// Builds the public source snapshot that is pushed to github.com/code-ksa/abdocode.
//
// The source repository carries internal material next to the product: `docs/` holds the
// maintainer's sprint programs and specs, `work/` holds session scratch, and `.github/` holds a
// workflow the distribution token cannot push. None of that ships. `public-docs/` is the English
// documentation written for the public repository and is promoted to `docs/` in the snapshot, so
// every link in README.md, AGENTS.md and llms.txt resolves there.
//
// Order of proof: gate on the source tree → archive HEAD (tracked files only, export-ignore
// honoured) → drop private roots → promote public-docs → gate again inside the snapshot → receipt.
//
// Usage: node scripts/public-snapshot.mjs [output-dir]   (default: work/public-snapshot)
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const out = resolve(process.argv[2] ?? join("work", "public-snapshot"))
const PRIVATE_ROOTS = ["docs", "work", ".github"]
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options })
const gate = resolve("scripts", "public-boundary-gate.mjs")

const head = run("git", ["rev-parse", "--short", "HEAD"]).trim()
const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).trim()
if (dirty.length > 0) console.error(`PUBLIC_SNAPSHOT_WARN working tree has uncommitted tracked changes — the snapshot is HEAD (${head}) only`)

// 1. the source tree must already be clean of private markers
process.stdout.write(run(process.execPath, [gate]))

// 2. archive HEAD: untracked scratch never ships; `docs/` and `work/` are export-ignore in .gitattributes
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
// the archive travels through a pipe: GNU tar on Windows reads a `C:\…` path as a remote host
const archive = execFileSync("git", ["archive", "--format=tar", "--worktree-attributes", "HEAD"], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 * 1024 * 1024 })
execFileSync("tar", ["-xf", "-"], { cwd: out, input: archive, stdio: ["pipe", "inherit", "inherit"] })

// 3. belt and braces: drop the private roots even if export-ignore was not honoured, then promote the public docs
const dropped = []
for (const root of PRIVATE_ROOTS) if (existsSync(join(out, root))) { rmSync(join(out, root), { recursive: true, force: true }); dropped.push(root) }
if (!existsSync(join(out, "public-docs"))) throw new Error("public-docs/ is missing from HEAD — the public documentation must be committed before a snapshot")
renameSync(join(out, "public-docs"), join(out, "docs"))

// 4. the snapshot itself must pass the gate (its `docs/` is now the public documentation)
process.stdout.write(run(process.execPath, [gate], { cwd: out }))

// 5. receipt
const count = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0)
const docs = readdirSync(join(out, "docs")).join(",")
console.log(`PUBLIC_SNAPSHOT_OK head=${head} dir=${out} files=${count(out)} dropped=${dropped.join(",") || "none-present"} docs=${docs}`)
