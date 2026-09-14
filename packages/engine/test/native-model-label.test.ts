import { expect, test } from "bun:test"
import { modelDisplayLabel } from "../../desktop/ui/provider-display.js"

test("the actual composer renderer follows Chat or Code and preserves an active turn's routed label", async () => {
  const source = await Bun.file(new URL("../../desktop/ui/native-shell.js", import.meta.url)).text()
  const renderer = source.match(/function renderSelectedModel\(\)\{[^\n]+\}\r?\n/u)?.[0]
  expect(renderer).toBeDefined()
  const render = new Function("bridge", "modelDisplayLabel", "shellMode", `${renderer};renderSelectedModel();`)
  const settings = {
    modelRole: "agent", agentModel: "qwen-token-plan/qwen3.8-max-preview",
    chatModel: "deepseek/deepseek-v4-flash", model: "ollama/qwen2b-gpu:latest",
  }
  const labels: string[] = []
  let working = false
  const bridge = { snapshot: () => ({ settings, working }), setModelLabel: (label: string) => labels.push(label) }
  render(bridge, modelDisplayLabel, "code")
  expect(labels).toEqual(["qwen3.8-max-preview"])
  // A legacy routing preference cannot override the selected conversation mode.
  render(bridge, modelDisplayLabel, "chat")
  expect(labels.at(-1)).toBe("DeepSeek 4 Flash")
  settings.chatModel = ""
  render(bridge, modelDisplayLabel, "chat")
  expect(labels.at(-1)).toBe("qwen2b-gpu:latest")
  working = true
  settings.modelRole = "chat"
  render(bridge, modelDisplayLabel, "code")
  expect(labels).toHaveLength(3)
  working = false
  render(bridge, modelDisplayLabel, "code")
  expect(labels.at(-1)).toBe("qwen3.8-max-preview")
})
