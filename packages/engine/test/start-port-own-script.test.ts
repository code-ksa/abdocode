/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.139): «npm start» = «node server/server.js» في مشروعٍ سكربتُ dev فيه vite — أخذ منفذَ Vite 5173،
 * فحقنت النواةُ PORT=5173 وحجب المحكّمُ «لا إيصالَ يثبت الافتراضيّ 3000»، فأنفق النموذجُ حقبةً كاملة (٢٧ أداة) يثبت ما لم يكسره.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseServerCommand } from "../src/managed-server"

function fullStack(defaultPort: number) {
  const dir = mkdtempSync(join(tmpdir(), "abdo-start-port-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build", start: "node server/server.js" } }))
  writeFileSync(join(dir, "vite.config.js"), "export default {}\n")
  mkdirSync(join(dir, "server"))
  writeFileSync(join(dir, "server", "server.js"), `export function resolvePort(env = process.env) {\n  const n = Number(env && env.PORT);\n  return Number.isInteger(n) && n > 0 && n < 65536 ? n : ${defaultPort};\n}\n`)
  return dir
}

test("npm start runs the start script's own server on its own default port — not the Vite port of the dev script", () => {
  const dir = fullStack(4100)
  try {
    expect(parseServerCommand("npm start", dir)?.port).toBe(4100)
    expect(parseServerCommand("npm run start", dir)?.port).toBe(4100)
    expect(parseServerCommand("node server/server.js", dir)?.port).toBe(4100)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the twin: the dev script of the same project still gets Vite's port, and an explicit port stays sovereign", () => {
  const dir = fullStack(4100)
  try {
    expect(parseServerCommand("npm run dev", dir)?.port).toBe(5173)
    expect(parseServerCommand("npm start -- --port 4400", dir)?.port).toBe(4400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a node server whose file names no default port falls back to the shape default 3000, never to Vite's", () => {
  const dir = fullStack(4100)
  try {
    writeFileSync(join(dir, "server", "server.js"), "import http from 'node:http'\nhttp.createServer().listen(process.env.PORT)\n")
    expect(parseServerCommand("npm start", dir)?.port).toBe(3000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
