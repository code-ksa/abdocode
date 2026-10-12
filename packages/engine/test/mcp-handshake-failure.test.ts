/**
 * 10-10 — measured on the linked Slack connector: the service answered `initialize` with «App is not enabled for Slack MCP server access.
 * Please enable it here: …», the handshake returned [] silently, and the app said «no tools within the time limit». The refusal is kept.
 * Real child process speaking MCP on a real pipe.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Mcp } from "../src/mind/mcp"

const server = (initializeReply: string) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-mcp-refuse-"))
  const file = join(dir, "refuse-mcp.mjs")
  writeFileSync(file, [
    'const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n")',
    'let buffer = ""',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk.toString()',
    '  let cut',
    '  while ((cut = buffer.indexOf("\\n")) >= 0) {',
    '    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1)',
    '    if (!line.trim()) continue',
    '    let request; try { request = JSON.parse(line) } catch { continue }',
    '    if (request.id === undefined) continue',
    `    if (request.method === "initialize") { ${initializeReply}; continue }`,
    '    if (request.method === "tools/list") { send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }] } }); continue }',
    '  }',
    '})',
  ].join("\n"))
  return { dir, file }
}

test("a refused initialize: no tools, and the service's own reason is kept for the app to show", async () => {
  const { dir, file } = server('send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/A0/app-assistant" } })')
  const session = new Mcp.McpSession({ id: "refuser", command: [process.execPath, file] })
  try {
    expect(await session.handshake(6_000)).toEqual([])
    expect(session.handshakeFailure).toContain("initialize: App is not enabled for Slack MCP server access")
    expect(session.handshakeFailure).toContain("app-assistant")
  } finally { session.close(); rmSync(dir, { recursive: true, force: true }) }
}, 20_000)

test("the twin: a healthy server lists its tools and leaves no failure behind", async () => {
  const { dir, file } = server('send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "ok", version: "1" } } })')
  const session = new Mcp.McpSession({ id: "healthy", command: [process.execPath, file] })
  try {
    expect((await session.handshake(6_000)).map((t) => t.name)).toEqual(["healthy.ping"])
    expect(session.handshakeFailure).toBeUndefined()
  } finally { session.close(); rmSync(dir, { recursive: true, force: true }) }
}, 20_000)
