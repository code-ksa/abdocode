<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/knowledge-work-plugins@1f517b9de47e CONNECTORS.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
# Connectors

## Local MCP Server

This plugin uses a **local MCP server** instead of a remote connector.
The PDF server runs on your machine via `npx`.

| Category | Server | How it runs |
|----------|--------|-------------|
| PDF viewer & annotator | `@modelcontextprotocol/server-pdf` | Local stdio via `npx` (auto-installed) |

### Requirements
- Node.js >= 18
- Internet access for remote PDFs (arXiv, bioRxiv, etc.)
- No API keys or authentication needed
