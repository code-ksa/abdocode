# Connectors and MCP

AbdoCode is both an MCP client and a set of MCP servers.

## Connectors (Settings → Connections)

Each connector links a service to the agent with OAuth. Tokens are stored in the vault and granted to a child MCP server as environment variables; nothing is put on a command line.

| Connector | Kind | Endpoint | Notes |
|---|---|---|---|
| Google (Gmail · Calendar · Drive) | built-in server `mcp-google` | Google APIs | Needs an OAuth client you create in Google Cloud (client id + secret); refresh tokens are kept in the vault |
| Slack | remote MCP | `https://mcp.slack.com/mcp` | Needs a Slack app (client id + secret) with the loopback redirect |
| Linear | remote MCP | `https://mcp.linear.app/mcp` | Dynamic client registration |
| Notion | remote MCP | `https://mcp.notion.com/mcp` | Dynamic client registration |
| Asana | remote MCP | `https://mcp.asana.com/v2/mcp` | Dynamic client registration |
| Atlassian (Jira · Confluence) | remote MCP | `https://mcp.atlassian.com/v1/mcp` | Dynamic client registration |
| Figma | remote MCP | `https://mcp.figma.com/mcp` | Dynamic client registration |
| Intercom | remote MCP | `https://mcp.intercom.com/mcp` | Dynamic client registration |
| Granola (meeting notes) | remote MCP | `https://mcp.granola.ai/mcp` | Dynamic client registration; scope `mcp` |
| Gamma (presentations · docs) | remote MCP | `https://mcp.gamma.app/mcp` | Dynamic client registration; scopes `generate gamma:read` |
| GitHub | remote MCP | `https://api.githubcopilot.com/mcp/` | Dynamic client registration |

Linking: press **Connect**, sign in in the browser window that opens, and return to the app. **Forget** removes the tokens from the vault and the server from settings.

The registry is `packages/engine/src/connectors/registry.ts`; remote servers are bridged over stdio by `abdocode mcp-remote <url>` (Streamable HTTP, protocol 2025-11-25).

## Built-in MCP servers (use them from any MCP client)

| Command | What it exposes |
|---|---|
| `abdocode mcp-sqlite <db>` | tables, schema, read-only queries on a local SQLite database |
| `abdocode mcp-git` | repository status and history of the current project |
| `abdocode mcp-postgres` | read-only SQL over a Postgres connection granted through the environment |
| `abdocode mcp-google` | Gmail, Calendar and Drive with tokens granted through the environment |
| `abdocode mcp-google-search` | Google Programmable Search (key + cx from the vault handle `abdocode-google`) |
| `abdocode mcp-remote <https-url>` | stdio bridge to any remote MCP server with OAuth |
| `abdocode mcp-chrome-bridge` | the local end of the Chrome/Edge extension |

Inside AbdoCode, the MCP catalogue only offers servers shipped in this binary. To attach a third-party server, add its command yourself in Settings → Connections; the engine will not download or run anything on first click.

## Search without a key

The `search` tool returns structured results when a Programmable Search key is stored under `abdocode-google`. Without it, the tool opens the results in the agent browser and tells the model the fallback path: `open <url>`, `dismiss` (closes language or cookie prompts), then `page` to read the results and their links.
