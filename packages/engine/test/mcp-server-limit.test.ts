/** The settings limit on MCP servers fits every connector linked, the built-in presets, and room for manual servers. */
import { expect, test } from "bun:test"
import { CONNECTORS } from "../src/connectors/registry"
import { McpCatalogue } from "../src/shells/mcp-catalogue"

const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

test("the limit leaves room after all connectors and presets", () => {
  const limit = Number(/const MAX_MCP_SERVERS = (\d+)/u.exec(cli)?.[1])
  expect(limit).toBeGreaterThanOrEqual(CONNECTORS.length + McpCatalogue.MCP_PRESETS.length + 4)
  expect(cli).toContain("value.mcpServers.length > MAX_MCP_SERVERS) return `mcpServers: قائمة حتى ${MAX_MCP_SERVERS} خادماً`")
})
