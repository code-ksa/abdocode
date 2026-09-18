// اللوحُ الحيّ لأفعال ن3 عبر الإضافة: إيدج حقيقيّ محمّلٌ بالإضافة (Playwright ‑ سياقٌ دائم) + جسرُ MCP الحقيقيّ على stdio.
// تُنادى select/upload/drag (وfill بكائنٍ) كما يناديها المحرّك، ثمّ تُقرأ الصفحةُ من الجهة الأخرى (Playwright) لإثبات الأثر:
// القائمةُ اختارت، الحقلُ يحمل الملفَّ، البطاقةُ انتقلت إلى العمود — إيصالٌ مقيس لا ادّعاء.
//   node scripts/sud-board.mjs [--engine <abdocode.exe|bun cli.ts>] [--headed]
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
const playwrightPackage = process.env.ABDO_PLAYWRIGHT_PACKAGE
if (!playwrightPackage) throw new Error("Set ABDO_PLAYWRIGHT_PACKAGE to an installed playwright package.json before running the board.")
const require = createRequire(playwrightPackage)
const { chromium } = require("playwright")

const stateDir = mkdtempSync(join(tmpdir(), "abdo-bridge-sud-"))
const port = 9300 + Math.floor(Math.random() * 500)
const token = "board-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
writeFileSync(join(stateDir, "chrome-bridge.json"), JSON.stringify({ version: 1, port, token, pid: 0, startedAt: new Date().toISOString() }))

// صفحةٌ محلّية: قائمةٌ منسدلة، حقلُ ملفّ، عمودان بالسحب والإفلات، وسطرُ حالةٍ يقول ما وقع.
const site = join(stateDir, "site"); mkdirSync(site)
const project = join(stateDir, "project"); mkdirSync(project); writeFileSync(join(project, "sample.txt"), "hello from abdocode upload\n")
writeFileSync(join(site, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>SUD board</title><body style="font-family:sans-serif">
<h1>SUD board</h1>
<label>City <select id="city" aria-label="City"><option value="">Choose…</option><option value="RUH">Riyadh</option><option value="JED">Jeddah</option><option value="DMM">Dammam</option></select></label>
<p><label>Resume <input id="file" type="file" aria-label="Resume"></label></p>
<div id="todo" role="list" aria-label="Todo column" style="display:inline-block;width:180px;min-height:100px;border:2px dashed #999;padding:8px"><div class="card" draggable="true" id="taskA" role="listitem" tabindex="0" style="padding:8px;margin:4px;background:#eef">Task A</div><div class="card" draggable="true" id="taskB" role="listitem" tabindex="0" style="padding:8px;margin:4px;background:#eef">Task B</div></div>
<div id="done" role="list" aria-label="Done column" style="display:inline-block;width:180px;min-height:100px;border:2px dashed #999;padding:8px"></div>
<div id="status" role="status" aria-label="Status">status: nothing yet</div>
<script>
const st=document.getElementById('status');const say=(t)=>{st.textContent='status: '+t}
document.getElementById('city').addEventListener('change',e=>say('city='+e.target.value))
document.getElementById('file').addEventListener('change',e=>say('file='+Array.from(e.target.files).map(f=>f.name+':'+f.size).join(',')))
let dragged=null
document.querySelectorAll('.card').forEach(c=>{c.addEventListener('dragstart',e=>{dragged=c;e.dataTransfer&&e.dataTransfer.setData('text/plain',c.id)})})
const done=document.getElementById('done')
done.addEventListener('dragover',e=>e.preventDefault())
done.addEventListener('drop',e=>{e.preventDefault();const id=(e.dataTransfer&&e.dataTransfer.getData('text/plain'))||(dragged&&dragged.id);const el=document.getElementById(id);if(el){done.appendChild(el);say('moved '+el.textContent+' to Done')}})
</script></body></html>`)
const { createServer } = await import("node:http")
const server = createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(readFileSync(join(site, "index.html"))) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const siteUrl = `http://127.0.0.1:${server.address().port}/`

const bunExe = [process.env.BUN_EXE, join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"), join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe")].find((c) => c && existsSync(c)) ?? "bun"
const engine = args.includes("--engine") ? args[args.indexOf("--engine") + 1].split(" ") : [bunExe, join(repo, "packages", "engine", "src", "cli.ts")]
const child = spawn(engine[0], [...engine.slice(1), "mcp-chrome-bridge", stateDir, String(port)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ABDO_CODE_STATE_DIR: stateDir } })
let stderr = ""
child.stderr.on("data", (d) => { stderr += d })
let buffer = ""; const pending = new Map(); let seq = 0
child.stdout.on("data", (d) => { buffer += d; let i; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } } catch {} } })
const rpc = (method, params, timeout = 25000) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)) }, timeout) })
const call = async (name, a = {}) => { const r = await rpc("tools/call", { name, arguments: a }); return r.result?.content?.[0]?.text ?? JSON.stringify(r) }

const receipts = []
const ok = (label, cond, detail = "") => { receipts.push(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + String(detail).slice(0, 220) : ""}`); if (!cond) process.exitCode = 1 }

let context
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sud-board", version: "1" } })
  ok("MCP initialize", !!init.result)
  const list = await rpc("tools/list", {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  ok("tools/list يعلن select/upload/drag", ["select", "upload", "drag"].every((n) => names.includes(n)), names.join(","))

  const profile = join(stateDir, "profile")
  const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
  context = await chromium.launchPersistentContext(profile, { executablePath: edge, headless: false, args: [...(headed ? [] : ["--headless=new"]), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"] })
  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 })
  ok("عاملُ خدمة الإضافة حيّ", !!sw)
  await sw.evaluate(async ({ port, token }) => { await chrome.storage.local.set({ port, token }) }, { port, token })
  const page = await context.newPage()
  await page.goto(siteUrl)
  await page.bringToFront()
  const deadline = Date.now() + 15000
  let connected = false
  while (Date.now() < deadline) { try { const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); if (h.connected) { connected = true; break } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  ok("الإضافة اتّصلت بالجسر", connected)

  const tree = await call("page")
  const refOf = (re) => (tree.split("\n").find((l) => re.test(l)) ?? "").match(/\[(r\d+)\]/)?.[1]
  const city = refOf(/combobox/), file = refOf(/textbox:file: Resume|textbox: Resume/), taskB = refOf(/Task B/), done = refOf(/Done column/)
  ok("chrome.page يرى القائمةَ وحقلَ الملفّ والبطاقةَ والعمود", !!(city && file && taskB && done), tree.split("\n").slice(0, 8).join(" | "))

  // select — يُقرأ راجعاً من الجسر ومن الصفحة
  const selected = await call("select", { ref: city, text: "dammam" })
  ok("chrome.select يختار بالنصّ (بلا حساسيةٍ للحالة) ويقرأ القائمة", /اخترتُ «Dammam»/.test(selected) && /DMM/.test(selected), selected)
  ok("القيمةُ استقرّت في الصفحة وأطلقت change", (await page.inputValue("#city")) === "DMM" && (await page.textContent("#status")) === "status: city=DMM")
  const missing = await call("select", { ref: city, text: "Mecca" })
  ok("خيارٌ مفقود يُقال بالخيارات", /لا خيارَ يطابق/.test(missing) && /Riyadh/.test(missing), missing)
  const notSelect = await call("select", { ref: file, text: "x" })
  ok("غيرُ select يُقال باسمه", /ليس قائمةً منسدلةً/.test(notSelect), notSelect)

  // upload — بالمنقّح، ثمّ يُقرأ الحقلُ من الصفحة
  const uploaded = await call("upload", { ref: file, path: join(project, "sample.txt") })
  ok("chrome.upload يرفع ملفَّ المشروع بلا حوار نظام ويقرأ الحقل", /رفعتُ «sample.txt»/.test(uploaded) && /27 بايت/.test(uploaded), uploaded)
  const landed = await page.evaluate(() => Array.from(document.getElementById("file").files).map((f) => f.name + ":" + f.size).join(","))
  ok("الملفُّ في الحقل فعلاً وأطلق change", landed === "sample.txt:27" && (await page.textContent("#status")) === "status: file=sample.txt:27", landed)
  const secret = await call("upload", { ref: file, path: join(project, ".env") })
  ok("ملفُّ اعتمادٍ يُرفض في الجسر أيضاً", /رُفض الرفع/.test(secret), secret)
  const relative = await call("upload", { ref: file, path: "sample.txt" })
  ok("مسارٌ نسبيّ يُرفض في الجسر (المحرّك يحلّه قبل الإرسال)", /رُفض الرفع/.test(relative), relative)

  // drag — الماوسُ الموثوق ثمّ أحداثُ HTML5؛ الأثرُ في DOM
  const dragged = await call("drag", { from: taskB, to: done })
  ok("chrome.drag يسحب البطاقةَ إلى العمود", /سحبتُ «Task B»/.test(dragged) && /«Done column»/.test(dragged), dragged)
  await page.waitForFunction(() => document.getElementById("done").children.length === 1, null, { timeout: 5000 }).catch(() => {})
  const parent = await page.evaluate(() => document.getElementById("taskB").parentElement.id)
  ok("البطاقةُ انتقلت فعلاً إلى Done", parent === "done" && (await page.textContent("#status")) === "status: moved Task B to Done", parent)

  // fill بكائنٍ — كما يبنيه المحرّك الآن
  const filled = await call("fill", { ref: city, text: "x" }).catch((e) => String(e))
  ok("chrome.fill بكائنٍ يصل الجسرَ (لا رفضَ مخطّط)", !/تحتاج كائنَ JSON/.test(filled), filled)
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
