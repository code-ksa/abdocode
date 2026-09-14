import { describe, expect, test } from "bun:test"
import {
  QUARANTINE_MANIFEST,
  classifySurface,
  evaluateReleaseSelection,
} from "./provenance-surface-gate.mjs"

describe("provenance surface gate", () => {
  test("detects inherited identity but preserves license attribution", () => {
    expect(classifySurface('{ "name": "OpenCode" }', "packages/ui/site.webmanifest"))
      .toContain("inherited-opencode-identity")
    expect(classifySurface('Copyright OpenCode contributors', "packages/ui/LICENSE"))
      .not.toContain("inherited-opencode-identity")
  })

  test("detects unsafe inherited capabilities", () => {
    const examples = [
      ["remote-config-discovery", "fetch('/.well-known/abdo')"],
      ["automatic-update", "autoupdate: true"],
      ["remote-mcp", "remote MCP server with OAuth"],
      ["public-session-share", "publicShare: true"],
      ["public-listen-default", 'host: "0.0.0.0"'],
      ["mdns-default", "mdns: true"],
      ["generated-js-ts-tools", "custom TypeScript tools"],
      ["clone-upstream", "clone a dependency repository"],
    ] as const

    for (const [ruleId, source] of examples) {
      expect(classifySurface(source, "packages/example/src/config.ts")).toContain(ruleId)
    }
  })

  test("the rebuilt web surface leaves no package quarantined", () => {
    expect(QUARANTINE_MANIFEST).toHaveLength(0)
    expect(evaluateReleaseSelection(["@abdo/web"])).toEqual([])
    expect(evaluateReleaseSelection(["@abdo/ui"])).toEqual([])
  })
})
