import { describe, expect, test } from "bun:test"
import { dirname, relative, resolve, sep } from "node:path"
import { mountNativeShell } from "../../desktop/ui/native-shell.js"
import { NativeDock } from "../../desktop/ui/native-dock.js"
import { applyLocale } from "../../desktop/ui/native-locale.js"

const ui = resolve(import.meta.dir, "../../desktop/ui")
const shellPath = resolve(ui, "native-shell.js")
const shell = await Bun.file(shellPath).text()
const parser = new Bun.Transpiler({ loader: "js", target: "browser" })

// This is a packaging/IPC boundary smoke gate. Actual clicks, drag geometry,
// native WebView placement and runtime outcomes still require browser/native
// journey tests; successful parsing alone does not qualify those journeys.
describe("production native shell smoke boundary", () => {
  test("the desktop entry's executable inline module parses and imports the production shell", async () => {
    const html = await Bun.file(resolve(ui, "index.html")).text()
    const modules = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((match) => /\btype\s*=\s*["']module["']/i.test(match[1]!))
    expect(modules.length).toBeGreaterThan(0)
    const imports: string[] = []
    for (const match of modules) {
      expect(() => parser.transformSync(match[2]!)).not.toThrow()
      imports.push(...parser.scanImports(match[2]!).map((item) => item.path))
    }
    expect(imports).toContain("./native-shell.js")
  })

  test("native modules expose their adapters without starting UI or requiring a DOM at import time", () => {
    expect(typeof mountNativeShell).toBe("function")
    expect(typeof NativeDock).toBe("function")
    expect(typeof NativeDock.prototype.move).toBe("function")
    expect(typeof NativeDock.prototype.close).toBe("function")
    expect(typeof applyLocale).toBe("function")
  })

  test("the eager shell import graph stays in the production package and never loads optional feature panels", async () => {
    const pending = [shellPath], visited = new Set<string>()
    while (pending.length) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      const source = await Bun.file(file).text()
      expect(() => parser.transformSync(source)).not.toThrow()
      for (const item of parser.scanImports(source)) {
        if (item.kind !== "import-statement") continue
        expect(item.path.startsWith(".")).toBe(true)
        const dependency = resolve(dirname(file), item.path)
        const path = relative(ui, dependency)
        expect(path === ".." || path.startsWith(".." + sep)).toBe(false)
        expect(path).not.toMatch(/(?:^|[\\/])(?:fixtures?|prototype|test)(?:[\\/]|$)/i)
        expect(path).not.toMatch(/(?:terminal|tasks|servers|approval|trajectory|deliverables)-panel\.js$/i)
        expect(await Bun.file(dependency).exists()).toBe(true)
        pending.push(dependency)
      }
    }
    expect(visited.size).toBeGreaterThan(1)
    const bundle = await Bun.build({ entrypoints: [shellPath], target: "browser", write: false })
    expect(bundle.success).toBe(true)
    expect(bundle.outputs.length).toBeGreaterThan(0)
    expect((await bundle.outputs[0]!.text()).length).toBeGreaterThan(0)
    // The locale dictionary may translate reference-preview labels; those
    // strings are not operational data. Reject them in the mounted shell.
    for (const oldFixture of ["Example result · local visual fixture", "preview@example.invalid", "demo-organization", "Future Rust integration"])
      expect({ fixture: oldFixture, included: shell.includes(oldFixture) }).toEqual({ fixture: oldFixture, included: false })
  })

  test("project data uses registered native IPC rather than the prototype's local state", async () => {
    const main = await Bun.file(resolve(ui, "../src-tauri/src/main.rs")).text()
    const workspace = await Bun.file(resolve(ui, "../src-tauri/src/workspace.rs")).text()
    const calls = new Set([...shell.matchAll(/\binvoke\(\s*['"](workspace_[a-z_]+)['"]/g)].map((match) => match[1]!))
    for (const required of ["workspace_store_get", "workspace_store_set", "workspace_tree", "workspace_read", "workspace_git_diff"])
      expect(calls.has(required)).toBe(true)
    for (const command of calls) {
      expect({ command, registered: main.includes(`workspace::${command}`) }).toEqual({ command, registered: true })
      const declared = new RegExp(`pub(?:\\(crate\\))?\\s+(?:async\\s+)?fn\\s+${command}\\b`).test(workspace)
      expect({ command, declared }).toEqual({ command, declared: true })
    }
    // Only dock geometry may use browser storage. The shell's projects,
    // schedules, names and paths are validated and persisted by native IPC.
    expect(shell).not.toMatch(/\b(?:localStorage|sessionStorage)\b/)
  })

  test("the merged reference surfaces call real editor, Git, worktree, artifact and memory boundaries", async () => {
    const surfaces = await Bun.file(resolve(ui, "native-surfaces.js")).text()
    const main = await Bun.file(resolve(ui, "../src-tauri/src/main.rs")).text()
    const workspace = await Bun.file(resolve(ui, "../src-tauri/src/workspace.rs")).text()
    const protocol = await Bun.file(resolve(ui, "../../transport-contracts/src/shell-protocol.ts")).text()
    expect(() => parser.transformSync(surfaces)).not.toThrow()
    for (const command of ["workspace_write", "workspace_git_action", "workspace_create_worktree"]) {
      expect(shell + surfaces).toContain(`'${command}'`)
      expect(main).toContain(command)
    }
    expect(workspace).toContain("fn create_worktree(")
    expect(workspace).toContain("struct Artifact")
    for (const kind of ["memory-list", "memory-note", "memory-forget", "memory-notes", "memory-saved", "memory-forgotten"])
      expect(protocol).toContain(`\"${kind}\"`)
  })
})
