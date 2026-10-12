/**
 * 10-08 — measured with gpt-6.1-sol: «audit http://localhost:3001/ http://localhost:3001/models» dropped both URLs and audited all 40 built
 * pages (185 errors) instead of the two asked for.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { auditRoutesFromArgs, isDevHmrNoise } from "../src/audit-routes"

test("local URLs on the managed port become their paths; the measured call audits exactly / and /models", () => {
  expect(auditRoutesFromArgs(["http://localhost:3001/", "http://localhost:3001/models", "--widths"], 3001)).toEqual({ routes: ["/", "/models"], refused: [] })
  expect(auditRoutesFromArgs(["http://127.0.0.1:3001/pricing?x=1", "/docs"], 3001).routes).toEqual(["/pricing?x=1", "/docs"])
})

test("another local port or an external site is named, not silently swapped for every page", () => {
  const r = auditRoutesFromArgs(["http://localhost:3000/"], 3001)
  expect(r.routes).toEqual([])
  expect(r.refused[0]).toContain("3000")
  expect(auditRoutesFromArgs(["https://openrouter.ai/"], 3001).refused[0]).toContain("خارجيّ")
})

test("the audit tool reads its routes through auditRoutesFromArgs", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain("const parsedRoutes = auditRoutesFromArgs(")
  expect(cli).toContain("let routes = parsedRoutes.routes")
})

// 10-08 — measured: 7 audit "errors" on two pages were Next prefetches the browser canceled (status 200) and dev HMR sockets.
test("dev HMR socket noise is not a page error; a real console error still is", () => {
  expect(isDevHmrNoise("WebSocket connection to 'ws://127.0.0.1:3000/_next/hmr?id=VVIi' failed: Error during WebSocket handshake")).toBe(true)
  expect(isDevHmrNoise("WebSocket connection to 'ws://localhost:5173/@vite/client' failed")).toBe(true)
  expect(isDevHmrNoise("TypeError: Cannot read properties of undefined (reading 'map')")).toBe(false)
  expect(isDevHmrNoise("WebSocket connection to 'wss://api.example.com/stream' failed")).toBe(false)
})

test("the audit drops canceled requests and HMR noise but keeps 4xx/5xx and connection failures", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain('(r.failure !== undefined && r.failure !== "canceled")')
  expect(cli).toContain("&& !isDevHmrNoise(c.text))")
  expect(cli).toContain("(r.status !== undefined && r.status >= 400)")
})
