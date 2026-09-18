import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"

let pass = 0
let fail = 0
const ok = (name, note = "") => { console.log(`PASS ${name}${note ? ` — ${note}` : ""}`); pass++ }
const bad = (name, note = "") => { console.log(`FAIL ${name}${note ? ` — ${note}` : ""}`); fail++ }

const skip = new Set([".git", "node_modules", "target", ".turbo", "dist"])
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".toml", ".md", ".rs", ".html", ".css", ".yml", ".yaml"])
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = path.join(dir, name)
    const entry = statSync(full)
    if (entry.isDirectory()) walk(full)
    else if (textExtensions.has(path.extname(name).toLowerCase())) files.push(full)
  }
}
walk(".")

const forbiddenHosts = ["opncd.ai", "opencode.ai", "console.opencode", "anoma.ly", "sst.dev", "models.dev"]
const hostHits = []
for (const file of files) {
  if (file.startsWith(`docs${path.sep}`) || file.startsWith(`scripts${path.sep}`) || file.includes(`${path.sep}test${path.sep}`)) continue
  if (file.endsWith(path.join("packages", "egress", "src", "egress.ts"))) continue
  const source = readFileSync(file, "utf8").toLowerCase()
  const host = forbiddenHosts.find((value) => source.includes(value))
  if (host) hostHits.push(`${file}:${host}`)
}
hostHits.length === 0 ? ok("no inherited host in executable source", `${files.length} files`) : bad("no inherited host in executable source", hostHits.slice(0, 8).join(", "))

const remotes = execFileSync("git", ["remote", "-v"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
const foreignRemote = remotes.filter((line) => /opencode|anomalyco|sst\.dev/i.test(line))
foreignRemote.length === 0 ? ok("no inherited git remote") : bad("no inherited git remote", foreignRemote.join(", "))

const packages = readdirSync("packages").filter((name) => existsSync(path.join("packages", name, "package.json")))
const effectDeps = packages.filter((name) => {
  const manifest = JSON.parse(readFileSync(path.join("packages", name, "package.json"), "utf8"))
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some((group) => group?.effect !== undefined)
})
effectDeps.length === 0 ? ok("no Effect dependency", `${packages.length} packages`) : bad("no Effect dependency", effectDeps.join(", "))

const replaced = ["abdo", "core", "server", "protocol", "cli", "host", "desktop-updater"].filter((name) => existsSync(path.join("packages", name)))
replaced.length === 0 ? ok("replaced core packages absent") : bad("replaced core packages absent", replaced.join(", "))

const engine = readFileSync("packages/engine/src/cli.ts", "utf8")
engine.includes("installEgressGuard()") && engine.includes('from "@abdo/egress"')
  ? ok("egress guard installed at engine entry")
  : bad("egress guard installed at engine entry")

const egress = readFileSync("packages/egress/src/egress.ts", "utf8")
const denyFirst = egress.indexOf("policy.forbidden.find") < egress.indexOf("policy.rules.find")
const defaultDeny = egress.includes('reason: "destination was never declared"')
const noAutonomousInternet = !/match:\s*"(?:api\.)?github\.com"|registry\.npmjs\.org/.test(egress)
denyFirst && defaultDeny && noAutonomousInternet ? ok("egress is forbidden-first and default-deny") : bad("egress is forbidden-first and default-deny")

// اسمٌ يُطابَق بالاحتواء يقبل الاسمَ المتقاعد أيضاً: «AbdoCodeAlAkhbari» يحتوي
// «AbdoCode»، فنصفُ الحارس كان ميّتاً — ردّةٌ كاملةٌ إلى الاسم القديم تمرّ وهو
// يطبع النجاح. تُقرأ الحقولُ بقيمها لا بحروفٍ داخلها، ويُضمّ إليها العنوانُ
// المرئيُّ — إنجليزيٌّ بطلب المالك (2026-09-06، `serve-wiring.test.ts`؛ العربيّةُ هويّةُ المساعد داخل البروتوكول) ومسارُ المُنصِّب،
// لأنّ NSIS يشتقّ اسم الملفّ من productName بينما cli.ts يكتبه بيده.
const desktop = JSON.parse(readFileSync("packages/desktop/src-tauri/tauri.conf.json", "utf8"))
const installerName = `"${desktop.productName}_${desktop.version}_x64-setup.exe"`
desktop.productName === "AbdoCode" &&
desktop.identifier === "io.abdocode.desktop" &&
desktop.app.windows[0].title === "AbdoCode" &&
engine.includes(installerName)
  ? ok("desktop identity belongs to AbdoCode", `${desktop.productName} · ${desktop.app.windows[0].title}`)
  : bad("desktop identity belongs to AbdoCode", `${desktop.productName} · ${desktop.identifier} · ${desktop.app.windows[0].title} · installer ${installerName}`)

const updateOrShare = files.filter((file) => /(?:auto.?update|share-next|session.?share)/i.test(path.basename(file)))
updateOrShare.length === 0 ? ok("no updater or session-sharing implementation") : bad("no updater or session-sharing implementation", updateOrShare.join(", "))

const root = JSON.parse(readFileSync("package.json", "utf8"))
const publishable = packages.filter((name) => JSON.parse(readFileSync(path.join("packages", name, "package.json"), "utf8")).private !== true)
root.private === true && publishable.length === 0 ? ok("all packages private") : bad("all packages private", publishable.join(", "))

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exitCode = fail === 0 ? 0 : 1
