import { candidate } from "@abdo/compaction"
import { selectMode } from "@abdo/context"
import { FactStore } from "@abdo/memory"
import { ProjectIndex } from "@abdo/project-index"
import { EventTypes } from "@abdo/session-runtime"
import { ToolRegistry } from "@abdo/tools"
import { readFileSync } from "node:fs"

export function stackStatus() {
  const index = new ProjectIndex()
  index.upsert("engine/stack.ts", readFileSync(import.meta.path, "utf8"))

  const memory = new FactStore()
  const fact = memory.record({
    projectId: "abdocode",
    kind: "architecture_decision",
    key: "kernel",
    value: "rust-main",
    sourceFilePaths: [import.meta.path],
  })
  memory.verify(fact.id)

  const registry = new ToolRegistry()
  const budget = candidate("engine", "system_safety", "عبدو كود")

  return {
    product: "عبدو كود",
    project: "rust-main",
    mode: selectMode({ touchesFiles: true }),
    indexedFiles: index.size,
    verifiedFacts: memory.current("abdocode").length,
    registeredTools: registry.list().length,
    runtimeEvents: Object.keys(EventTypes).length,
    budgetTokens: budget.tokens,
    budgetBytes: budget.bytes,
  }
}
