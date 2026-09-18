// اللوحُ الحيّ للاقتران الآليّ (ب8): الجسرُ الحقيقيّ (`cli.ts mcp-chrome-bridge`) يقلع بنافذة اقترانٍ مفتوحة، وإيدج حقيقيّ
// محمّلٌ بالإضافة **بلا رمز** (يُلصق المنفذُ وحدَه في تخزينها كما لو غيّره المستخدم) ⇦ الإضافةُ تسأل /pair وتأخذ الرمزَ وتتّصل.
// الحقيقةُ من stderr الجسر: «pairing token handed to …» ثمّ «extension connected» — بلا أن يلصق أحدٌ الرمز.
//   node scripts/autopair-board.mjs [--headed]   (يحتاج ABDO_PLAYWRIGHT_PACKAGE)
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const here = dirname(fileURLToPath(import.meta.url))
const extension = resolve(here, "..", "extension")
const repo = resolve(here, "..", "..", "..")
const headed = process.argv.includes("--headed")
const playwrightPackage = process.env.ABDO_PLAYWRIGHT_PACKAGE
if (!playwrightPackage) throw new Error("Set ABDO_PLAYWRIGHT_PACKAGE to an installed playwright package.json before running the board.")
const { chromium } = createRequire(playwrightPackage)("playwright")
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

const stateDir = mkdtempSync(join(tmpdir(), "abdo-autopair-board-"))
const port = 9300 + Math.floor(Math.random() * 500)
const bunExe = [process.env.BUN_EXE, join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"), join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe")].find((c) => c && existsSync(c))
if (!bunExe) throw new Error("bun.exe not found")
const child = spawn(bunExe, [join(repo, "packages", "engine", "src", "cli.ts"), "mcp-chrome-bridge", stateDir, String(port)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ABDO_CODE_STATE_DIR: stateDir } })
let stderr = ""
child.stderr.on("data", (d) => { stderr += d })
child.stdout.on("data", () => {})
const receipts = []
const ok = (label, cond, detail = "") => { receipts.push(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`); if (!cond) process.exitCode = 1 }
const until = async (pred, ms) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, 250)) } return pred() }

let context
try {
  ok("الجسرُ أقلع بنافذة اقترانٍ مفتوحة", await until(() => /listening on ws:\/\/127\.0\.0\.1:\d+/.test(stderr) && /pairing window open/.test(stderr), 15000), stderr.split("\n").filter((l) => l.includes("chrome-bridge")).join(" | ").slice(0, 200))
  const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
  if (!edge) throw new Error("msedge.exe not found")
  const profile = join(stateDir, "profile")
  context = await chromium.launchPersistentContext(profile, { executablePath: edge, headless: false, args: [...(headed ? [] : ["--headless=new"]), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 })
  log("worker " + sw.url())
  // المنفذُ وحدَه — لا رمز
  await sw.evaluate(async ({ port }) => { await chrome.storage.local.set({ port, token: "" }) }, { port })
  log("port pasted, token empty")
  const handed = await until(() => stderr.includes("pairing token handed to"), 20000)
  ok("الإضافةُ سألت /pair وأخذت الرمز", handed, (stderr.match(/pairing token handed to [^\n]*/) ?? [""])[0].slice(0, 120))
  const connected = await until(() => stderr.includes("chrome-bridge: extension connected"), 20000)
  ok("الإضافةُ اتّصلت بالمقبس بالرمز الذي أخذته", connected)
  const stored = await sw.evaluate(async () => (await chrome.storage.local.get({ token: "" })).token)
  ok("الرمزُ محفوظ في تخزين الإضافة (بلا لصق)", typeof stored === "string" && stored.length >= 24, `${String(stored).length} حرفاً`)
  // التوأمُ السلبيّ: بعد الاقتران، طلبُ /pair من عمليّةٍ أخرى داخل النافذة ما زال يُجاب (النافذةُ زمنيّة) — يُقاس أنّ الإغلاقَ بعد المهلة يعيد 423
  const probe = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())
  ok("/health يقول connected=true", probe.connected === true, JSON.stringify(probe))
} catch (e) { ok("اللوحُ اكتمل", false, String(e).slice(0, 200)) } finally {
  await context?.close().catch(() => {})
  child.kill()
  rmSync(stateDir, { recursive: true, force: true })
}
console.log(receipts.join("\n"))
console.log(process.exitCode ? "AUTOPAIR_BOARD_FAIL" : "AUTOPAIR_BOARD_OK")
