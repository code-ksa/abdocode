import { expect, test } from "bun:test"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../desktop")
const surfaces = await Bun.file(resolve(root, "ui/native-surfaces.js")).text()
const workspace = await Bun.file(resolve(root, "src-tauri/src/workspace.rs")).text()
const main = await Bun.file(resolve(root, "src-tauri/src/main.rs")).text()
const parser = new Bun.Transpiler({ loader: "js", target: "browser" })

test("native Git surface exposes real PR commands and never labels comparison as a receipt", () => {
  expect(() => parser.transformSync(surfaces)).not.toThrow()
  for (const command of [
    "workspace_git_provider_status",
    "workspace_git_pull_requests",
    "workspace_git_create_pull_request",
  ]) {
    expect(surfaces).toContain(`'${command}'`)
    expect(main).toContain(`workspace::${command}`)
    expect(workspace).toMatch(new RegExp(`fn\\s+${command}\\b`))
  }
  expect(surfaces).toContain("createPullRequest:openPullRequestDialog")
  expect(surfaces).toContain("confirmed:true")
  expect(surfaces).toContain("Open comparison")
  expect(surfaces).not.toContain("Draft pull request','مسودة طلب دمج'),()=>openLink(remote.compareUrl)")
})

test("project writes and Git mutations are gated to Code and project removal rechecks Dispatch", () => {
  expect(surfaces).toContain("state().shellMode!=='code'")
  expect(surfaces).toContain("Switch to Code to change project files or Git state.")
  expect(surfaces).toContain("await verifyProjectCanBeRemoved(removedId)")
  expect(surfaces).toContain("bridge.invoke('automation_status')")
  expect(surfaces).toContain("['queued','running','needs-input'].includes(item.status)")
  expect(surfaces).toContain("['dispatch','Dispatch','التفويض','clock']")
})
