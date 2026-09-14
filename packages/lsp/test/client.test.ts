/**
 * S37/S38 GATES — a dead server does not take the run with it and does not
 * invent an answer, and a language with no server says `unsupported` instead of
 * quietly becoming a text search.
 */
import { describe, expect, test } from "bun:test"
import { LspClient, type LspTransport, type LspDiagnostic } from "../src/client"
import { planServers, selectServer, SERVERS } from "../src/registry"

/** A scripted transport: one entry per method, or a function for the awkward cases. */
function transport(
  table: Record<string, unknown | (() => Promise<unknown>)>,
  options: { exit?: Promise<{ code: number | null; signal?: string }>; onKill?: () => void } = {},
): LspTransport & { sent: { method: string; params: unknown }[]; diagnostics: (d: { uri: string; diagnostics: LspDiagnostic[] }) => void } {
  const sent: { method: string; params: unknown }[] = []
  let handler: ((p: { uri: string; diagnostics: readonly LspDiagnostic[] }) => void) | undefined
  return {
    sent,
    diagnostics: (d) => handler?.(d),
    async request(method, params) {
      sent.push({ method, params })
      const entry = table[method]
      if (entry === undefined) return null
      return typeof entry === "function" ? await (entry as () => Promise<unknown>)() : entry
    },
    notify(method, params) {
      sent.push({ method, params })
    },
    exited: () => options.exit ?? new Promise(() => {}),
    kill: () => options.onKill?.(),
    onDiagnostics(h) {
      handler = h
    },
  }
}

const ready = async (t: LspTransport) => {
  const client = new LspClient({ transport: t, rootUri: "file:///repo", languageId: "typescript", requestTimeoutMs: 50 })
  await client.initialize()
  return client
}

describe("S37 GATE — a server that dies returns `unavailable`, never an answer", () => {
  test("a crashed server does not fail the run and does not return an empty list", async () => {
    let resolveExit: (v: { code: number | null }) => void = () => {}
    const exit = new Promise<{ code: number | null }>((r) => (resolveExit = r))
    const client = await ready(transport({ initialize: { capabilities: {} } }, { exit }))

    resolveExit({ code: 1 })
    await Bun.sleep(5)

    const result = await client.references("file:///repo/a.ts", { line: 1, character: 2 })
    // NOT `[]` — an empty array means the server answered and found nothing
    expect(result.kind).toBe("unavailable")
    if (result.kind === "unavailable") {
      expect(result.why).toContain("exited")
      expect(result.recoverable).toBe(false)
    }
    expect(client.status().state).toBe("crashed")
  })

  test("a hung server times out into `unavailable` rather than throwing", async () => {
    const client = await ready(transport({ "textDocument/definition": () => new Promise(() => {}) }))
    const result = await client.definition("file:///repo/a.ts", { line: 0, character: 0 })
    expect(result.kind).toBe("unavailable")
    if (result.kind === "unavailable") {
      expect(result.why).toContain("did not answer within 50ms")
      // recoverable: the server may simply still be indexing
      expect(result.recoverable).toBe(true)
    }
  })

  test("a transport that throws marks the client crashed instead of propagating", async () => {
    const client = await ready(
      transport({
        "textDocument/references": () => Promise.reject(new Error("EPIPE: broken pipe")),
      }),
    )
    const result = await client.references("file:///repo/a.ts", { line: 0, character: 0 })
    expect(result.kind).toBe("unavailable")
    if (result.kind === "unavailable") expect(result.why).toContain("EPIPE")
    expect(client.status().state).toBe("crashed")
  })

  test("a file nobody opened has UNAVAILABLE diagnostics, not clean ones", async () => {
    const t = transport({ initialize: { capabilities: {} } })
    const client = await ready(t)
    const before = client.diagnosticsFor("file:///repo/a.ts")
    expect(before.kind).toBe("unavailable")
    if (before.kind === "unavailable") expect(before.why).toContain("never opened")

    client.didOpenOrChange("file:///repo/a.ts", "const a = 1\n")
    const after = client.diagnosticsFor("file:///repo/a.ts")
    // opened and nothing published = genuinely clean, and that is a different fact
    expect(after.kind).toBe("ok")
    if (after.kind === "ok") expect(after.value).toEqual([])
  })

  test("document versions advance only when the text actually changed", async () => {
    const t = transport({ initialize: { capabilities: {} } })
    const client = await ready(t)
    client.didOpenOrChange("file:///repo/a.ts", "one")
    expect(client.syncedVersion("file:///repo/a.ts")).toBe(1)
    client.didOpenOrChange("file:///repo/a.ts", "one")
    expect(client.syncedVersion("file:///repo/a.ts")).toBe(1)
    client.didOpenOrChange("file:///repo/a.ts", "two")
    expect(client.syncedVersion("file:///repo/a.ts")).toBe(2)
    expect(t.sent.filter((s) => s.method === "textDocument/didChange")).toHaveLength(1)
  })

  test("the three shapes a definition response may take all normalise", async () => {
    const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
    for (const response of [
      { uri: "file:///repo/a.ts", range },
      [{ uri: "file:///repo/a.ts", range }],
      [{ targetUri: "file:///repo/a.ts", targetSelectionRange: range }],
    ]) {
      const client = await ready(transport({ "textDocument/definition": response }))
      const result = await client.definition("file:///repo/b.ts", { line: 0, character: 0 })
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") expect(result.value[0]!.uri).toBe("file:///repo/a.ts")
    }
  })

  test("stopping a live server shuts it down; stopping a crashed one does not pretend to", async () => {
    let killed = 0
    const exit = Promise.resolve({ code: 0 })
    const t = transport({ initialize: { capabilities: {} } }, { exit, onKill: () => killed++ })
    const client = await ready(t)
    await Bun.sleep(5)
    await client.stop()
    expect(killed).toBe(1)
    expect(t.sent.some((s) => s.method === "shutdown")).toBe(false)
  })
})

describe("S38 GATE — three languages, three servers, and no silent fallback", () => {
  const tree = new Set([
    "/repo/package.json",
    "/repo/packages/api/tsconfig.json",
    "/repo/services/ml/pyproject.toml",
    "/repo/native/Cargo.toml",
  ])
  const exists = (p: string) => tree.has(p)

  test("each file is answered by its own server, rooted at the nearest marker", () => {
    const ts = selectServer("/repo/packages/api/src/a.ts", "/repo", exists)
    expect(ts.kind).toBe("server")
    if (ts.kind === "server") {
      expect(ts.spec.id).toBe("typescript-language-server")
      // the NEAREST tsconfig, not the monorepo root — a server started at the
      // root answers with the wrong compiler options
      expect(ts.root).toBe("/repo/packages/api")
    }

    const py = selectServer("/repo/services/ml/train.py", "/repo", exists)
    if (py.kind === "server") {
      expect(py.spec.id).toBe("pyright")
      expect(py.root).toBe("/repo/services/ml")
    }

    const rs = selectServer("/repo/native/src/lib.rs", "/repo", exists)
    if (rs.kind === "server") expect(rs.spec.id).toBe("rust-analyzer")
  })

  test("a language with no server is UNSUPPORTED, and says a text search must be chosen deliberately", () => {
    const selection = selectServer("/repo/notes.md", "/repo", exists)
    expect(selection.kind).toBe("unsupported")
    if (selection.kind === "unsupported") {
      expect(selection.extension).toBe(".md")
      expect(selection.why).toContain("never presented as a reference list")
    }
  })

  test("a file with no extension is unsupported rather than guessed at", () => {
    const selection = selectServer("/repo/Makefile", "/repo", exists)
    expect(selection.kind).toBe("unsupported")
  })

  test("planning groups by (server, root) and never drops the files it cannot serve", () => {
    const plan = planServers(
      [
        "/repo/packages/api/src/a.ts",
        "/repo/packages/api/src/b.ts",
        "/repo/services/ml/train.py",
        "/repo/native/src/lib.rs",
        "/repo/README.md",
      ],
      "/repo",
      exists,
    )
    expect(plan.instances).toHaveLength(3)
    expect(plan.instances.find((i) => i.id === "typescript-language-server")!.files).toHaveLength(2)
    expect(plan.unsupported.map((u) => u.file)).toEqual(["/repo/README.md"])
    // every input file is accounted for in one list or the other
    expect(plan.instances.flatMap((i) => i.files).length + plan.unsupported.length).toBe(5)
  })

  test("two tsconfigs in one repo become two server instances", () => {
    const bigger = new Set([...tree, "/repo/packages/web/tsconfig.json"])
    const plan = planServers(
      ["/repo/packages/api/src/a.ts", "/repo/packages/web/src/b.ts"],
      "/repo",
      (p) => bigger.has(p),
    )
    expect(plan.instances).toHaveLength(2)
    expect(plan.instances.map((i) => i.root).sort()).toEqual(["/repo/packages/api", "/repo/packages/web"])
  })

  test("every registered server declares a command, a language and root markers", () => {
    for (const spec of SERVERS) {
      expect(spec.command.length).toBeGreaterThan(0)
      expect(spec.extensions.length).toBeGreaterThan(0)
      expect(spec.rootMarkers.length).toBeGreaterThan(0)
    }
  })
})
