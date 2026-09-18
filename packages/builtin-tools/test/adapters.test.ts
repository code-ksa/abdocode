import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEnforcedToolRunner, ToolRegistry } from "@abdo/tools"
import {
  gitReadTool,
  gitChangeTool,
  guardNetworkUrl,
  networkFetchTool,
  packageInstallTool,
  writeFileTool,
} from "../src"

const roots: string[] = []
const workspace = () => {
  const path = mkdtempSync(join(tmpdir(), "abdo-adapter-"))
  roots.push(path)
  return path
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const context = { dryRun: false } as const

describe("compiled product adapters", () => {
  test("write commits atomically and leaves no temporary sibling", async () => {
    const root = workspace()
    const result = await writeFileTool(root).run({ path: "nested/value.txt", content: "complete" }, context)
    expect(result.ok).toBe(true)
    expect(await Bun.file(join(root, "nested", "value.txt")).text()).toBe("complete")
    expect(readdirSync(join(root, "nested")).filter((name) => name.endsWith(".abdo-write.tmp"))).toEqual([])
    expect(result.mutation?.mutationCommitted).toBe(true)
  })

  test("Git read exposes only compiled actions and runs in the selected project", async () => {
    const root = workspace()
    Bun.spawnSync(["git", "init", "-q"], { cwd: root })
    writeFileSync(join(root, "owned.txt"), "owned")
    const tool = gitReadTool(root)
    const status = await tool.run({ action: "status" }, context)
    expect(status.ok).toBe(true)
    expect(JSON.stringify(status.output)).toContain("owned.txt")
    const push = await tool.run({ action: "push" }, context)
    expect(push.ok).toBe(false)
    if (push.ok) throw new Error("push was unexpectedly admitted")
    expect(push.error).toContain("must be status")
  })

  test("Git mutation binds one literal regular file and never a pathspec", async () => {
    const root = workspace()
    writeFileSync(join(root, "[wild].txt"), "owned")
    const tool = gitChangeTool(root)
    const plan = await tool.run({ action: "stage", path: "[wild].txt" }, { dryRun: true })
    expect(plan.ok).toBe(true)
    expect(plan.output).toMatchObject({ argv: ["add", "--", ":(literal)[wild].txt"], dryRun: true })
    const directory = await tool.run({ action: "stage", path: "." }, context)
    expect(directory.ok).toBe(false)
  })

  test("package restore requires a lockfile and emits only the safe fixed plan", async () => {
    const root = workspace()
    const tool = packageInstallTool(root)
    await expect(tool.dryRun!({ manager: "npm", network: "registry" })).rejects.toThrow("requires one of")
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {}, resolved: "https://registry.npmjs.org/x/-/x.tgz" }))
    expect(await tool.dryRun!({ manager: "npm", network: "registry" })).toMatchObject({
      executable: "npm",
      argv: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      network: "registry",
      lockfile: "package-lock.json",
    })
  })

  test("package restore refuses an unapproved lockfile source", async () => {
    const root = workspace()
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ resolved: "https://packages.attacker.invalid/x.tgz" }))
    await expect(packageInstallTool(root).dryRun!({ manager: "npm", network: "registry" })).rejects.toThrow("lockfile source refused")
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ resolved: "git+https://github.com/example/project.git" }))
    await expect(packageInstallTool(root, { packageRegistryHosts: ["github.com"] }).dryRun!({ manager: "npm", network: "registry" })).rejects.toThrow("non-registry")
  })

  test("network guard rejects local, OpenCode, DeepSeek and redirect-to-private targets", async () => {
    const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]
    expect((await guardNetworkUrl("https://localhost/x", { lookupHost: publicLookup as never })).ok).toBe(false)
    expect((await guardNetworkUrl("https://github.com/anomalyco/opencode", { lookupHost: publicLookup as never })).ok).toBe(false)
    expect((await guardNetworkUrl("https://api.deepseek.com/v1", { lookupHost: publicLookup as never })).ok).toBe(false)

    let calls = 0
    const tool = networkFetchTool({
      lookupHost: (async (host: string) => [{ address: host === "private.invalid" ? "127.0.0.1" : "93.184.216.34", family: 4 }]) as never,
      requestFetch: (async () => {
        calls += 1
        return new Response(null, { status: 302, headers: { location: "https://private.invalid/secret" } })
      }) as never,
    })
    const result = await tool.run({ url: "https://public.invalid/start" }, context)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("private redirect was unexpectedly admitted")
    expect(result.error).toContain("private DNS answer")
    expect(calls).toBe(1)
  })

  test("network adapter returns bounded text with evidence", async () => {
    const tool = networkFetchTool({
      lookupHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
      requestFetch: (async () => new Response("x".repeat(5_000), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })) as never,
    })
    const result = await tool.run({ url: "https://example.com/data" }, context)
    expect(result.ok).toBe(true)
    expect(result.output).toMatchObject({ status: 200, truncated: true })
    expect((result.output as { text: string }).text).toHaveLength(4_000)
    expect((result.output as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("critical adapters do not execute without an approver", async () => {
    const root = workspace()
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }))
    const registry = new ToolRegistry().register(packageInstallTool(root))
    const runner = createEnforcedToolRunner(registry, { identity: { workspace: root } })
    const denied = await runner.run(
      { name: "package_install", input: { manager: "npm", network: "offline" } },
      { executionId: "adapter-denied", mode: "BUILD" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("critical adapter was unexpectedly admitted")
    expect(denied.denied).toBe(true)
  })
})
