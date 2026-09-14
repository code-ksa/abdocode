// اللوحُ الحيّ لإضافة المتصفّح: إيدج حقيقيّ محمّلٌ بالإضافة (Playwright ‑ سياقٌ دائم) + جسرُ MCP الحقيقيّ (`abdocode mcp-chrome-bridge`)
// على stdio + الرمزُ يُلصق في تخزين الإضافة كما يفعل المستخدم في النافذة المنبثقة. ثمّ تُنادى الأدواتُ عبر MCP كما يناديها
// المحرّك: page ⇦ tap ⇦ fill ⇦ key ⇦ look ⇦ shot — والإيصالُ أسطرٌ مقيسة لا ادّعاء.
//   node scripts/board.mjs [--engine <abdocode.exe|bun cli.ts>] [--headed]
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const here = dirname(fileURLToPath(import.meta.url))
const extension = resolve(here, "..", "extension")
const repo = resolve(here, "..", "..", "..")
const args = process.argv.slice(2)
const headed = args.includes("--headed")
// مسارُ playwright من البيئة لا من جهازِ مطوّرٍ بعينه: مسارٌ مثبَّتٌ يشحن اسمَ بنيتنا الداخلية
// في مصدرٍ عامّ، وبوّابةُ الحدّ العامّ ترفضه. غيابُ المتغيّر رفضٌ صريحٌ لا سقوطٌ صامت.
const playwrightPackage = process.env.ABDO_PLAYWRIGHT_PACKAGE
if (!playwrightPackage) throw new Error("Set ABDO_PLAYWRIGHT_PACKAGE to an installed playwright package.json before running the board.")
const require = createRequire(playwrightPackage)
const { chromium } = require("playwright")

const stateDir = mkdtempSync(join(tmpdir(), "abdo-bridge-board-"))
const port = 9300 + Math.floor(Math.random() * 500)
const token = "board-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
writeFileSync(join(stateDir, "chrome-bridge.json"), JSON.stringify({ version: 1, port, token, pid: 0, startedAt: new Date().toISOString() }))

// صفحةٌ محلّية للتسجيل: حقلٌ عاديّ وحقلُ كلمة مرور وزرّ — كما في ب5.
const site = join(stateDir, "site"); mkdirSync(site)
writeFileSync(join(site, "index.html"), `<!doctype html><html lang="ar"><meta charset="utf-8"><title>Board signup</title><body style="font-family:sans-serif"><h1>سجّل</h1><form onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('email').value"><label>البريد <input id="email" name="email" placeholder="you@example.com"></label><label>كلمة المرور <input id="pw" type="password" name="password"></label><button id="go" type="submit">أنشئ الحساب</button></form><p id="out" style="color:#080"></p></body></html>`)
const { createServer } = await import("node:http")
const server = createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(readFileSync(join(site, "index.html"))) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const siteUrl = `http://127.0.0.1:${server.address().port}/`

// جسرُ MCP الحقيقيّ على stdio
// bun على ويندوز: تثبيتُ npm يضع bun.ps1 في PATH وnode لا يشغّله؛ يُبحث عن bun.exe في مواضعه المعروفة.
const bunExe = [process.env.BUN_EXE, join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"), join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe")].find((c) => c && existsSync(c)) ?? "bun"
const engine = args.includes("--engine") ? args[args.indexOf("--engine") + 1].split(" ") : [bunExe, join(repo, "packages", "engine", "src", "cli.ts")]
const child = spawn(engine[0], [...engine.slice(1), "mcp-chrome-bridge", stateDir, String(port)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ABDO_CODE_STATE_DIR: stateDir } })
let stderr = ""
child.stderr.on("data", (d) => { stderr += d })
let buffer = ""; const pending = new Map(); let seq = 0
child.stdout.on("data", (d) => { buffer += d; let i; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } } catch {} } })
const rpc = (method, params, timeout = 20000) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)) }, timeout) })
const call = async (name, a = {}) => { const r = await rpc("tools/call", { name, arguments: a }); return r.result?.content?.[0]?.text ?? JSON.stringify(r) }

const receipts = []
const ok = (label, cond, detail = "") => { receipts.push(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`); if (!cond) process.exitCode = 1 }

let context
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "board", version: "1" } })
  ok("MCP initialize", !!init.result, JSON.stringify(init.result?.serverInfo ?? init.error))
  const list = await rpc("tools/list", {})
  ok("tools/list يعلن 8 أدوات", (list.result?.tools ?? []).length === 8, (list.result?.tools ?? []).map((t) => t.name).join(","))

  // إيدج حقيقيّ بالإضافة
  const profile = join(stateDir, "profile")
  const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
  context = await chromium.launchPersistentContext(profile, { executablePath: edge, headless: false, args: [...(headed ? [] : ["--headless=new"]), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"] })
  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 })
  ok("عاملُ خدمة الإضافة حيّ", !!sw, sw?.url())
  // كما يلصق المستخدم الرمزَ في النافذة المنبثقة
  await sw.evaluate(async ({ port, token }) => { await chrome.storage.local.set({ port, token }) }, { port, token })
  const page = await context.newPage()
  await page.goto(siteUrl)
  await page.bringToFront()
  // انتظارُ اتصال الإضافة بالجسر
  const deadline = Date.now() + 15000
  let connected = false
  while (Date.now() < deadline) { try { const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); if (h.connected) { connected = true; break } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  ok("الإضافة اتّصلت بالجسر بالرمز", connected)

  const tree = await call("page")
  ok("chrome.page يقرأ شجرة الصفحة", /textbox/.test(tree) && /button/.test(tree), tree.split("\n").slice(0, 5).join(" | "))
  const refOf = (re) => (tree.split("\n").find((l) => re.test(l)) ?? "").match(/\[(r\d+)\]/)?.[1]
  const email = refOf(/textbox: you@example|textbox: email/i), pw = refOf(/textbox:password/), go = refOf(/button/)
  const filled = await call("fill", { ref: email, text: "board@example.com" })
  ok("chrome.fill يكتب في حقلٍ عاديّ بإدخالٍ موثوق", /كتبتُ/.test(filled) && /موثوق/.test(filled), filled)
  const refused = await call("fill", { ref: pw, text: "hunter2" })
  ok("chrome.fill يرفض حقلَ كلمة المرور (العقد)", /رفض/.test(refused), refused)
  const typedValue = await page.inputValue("#email")
  ok("القيمةُ وصلت الصفحةَ فعلاً", typedValue === "board@example.com", typedValue)
  const tapped = await call("tap", { ref: go })
  ok("chrome.tap ينقر الزرّ", /نقرتُ/.test(tapped), tapped)
  await page.waitForFunction(() => document.getElementById("out").textContent.startsWith("submitted:"), null, { timeout: 5000 }).catch(() => {})
  const out = await page.textContent("#out")
  ok("النقرةُ أرسلت النموذج (submitted)", out === "submitted:board@example.com", out)
  const looked = await call("look", { ref: go })
  ok("chrome.look يعيد أنماطاً محسوبة", /"styles"/.test(looked) && /font-size/.test(looked))
  const pressed = await call("key", { key: "Tab" })
  ok("chrome.key يضغط Tab", /ضغطتُ Tab/.test(pressed), pressed)
  const shot = await call("shot")
  const shotPath = shot.match(/([A-Za-z]:[^\s]+\.png)/)?.[1]
  ok("chrome.shot يحفظ PNG على القرص", !!shotPath && existsSync(shotPath) && readFileSync(shotPath).subarray(1, 4).toString() === "PNG", shot.slice(0, 80))
  const pairing = JSON.parse(readFileSync(join(stateDir, "chrome-bridge.json"), "utf8"))
  ok("الرمزُ ثابتٌ عبر التشغيل (persistedToken)", pairing.token === token && pairing.port === port)
} catch (error) {
  ok("اللوح اكتمل بلا استثناء", false, String(error?.stack ?? error).slice(0, 400))
} finally {
  try { await context?.close() } catch {}
  child.kill()
  server.close()
  console.log(receipts.join("\n"))
  console.log(`\nstderr(bridge): ${stderr.trim().split("\n").slice(0, 4).join(" | ")}`)
  setTimeout(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch {} }, 500)
}
