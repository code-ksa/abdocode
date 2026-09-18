import { describe, expect, test } from "bun:test"
import { EventTypes, type ModelClient, type ModelTurn } from "@abdo/session-runtime"
import { policy, type ToolDefinition } from "@abdo/tools"
import { createEngineHost } from "../src"

const scriptedModel = (turns: readonly ModelTurn[]): ModelClient => {
  let next = 0
  return {
    async call() {
      const turn = turns[Math.min(next, turns.length - 1)]
      if (turn === undefined) throw new Error("empty model script")
      next++
      return turn
    },
  }
}

const echoTool = (executed?: (input: unknown) => void): ToolDefinition => ({
  name: "echo",
  description: "Return the supplied value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  policy: policy({ risk: "read", idempotent: true }),
  async run(input) {
    executed?.(input)
    return { ok: true, output: input }
  },
})

describe("owned engine host", () => {
  test("admits input, runs it, and replays the durable session in order", async () => {
    const host = createEngineHost({
      model: scriptedModel([{ kind: "final", text: "done" }]),
      toolDefinitions: [echoTool()],
    })
    const inputId = await host.admit("ses_admit", "do the work")
    expect((await host.replay("ses_admit")).map((event) => event.type)).toEqual([EventTypes.InputAdmitted])

    const result = await host.run("ses_admit")
    expect(result).toEqual(expect.objectContaining({ state: "completed", text: "done" }))
    const events = await host.replay("ses_admit")
    expect(events.map((event) => event.type)).toContain(EventTypes.InputPromoted)
    expect(events.map((event) => Number(event.sequence))).toEqual(events.map((_event, sequence) => sequence))
    expect((events.find((event) => event.type === EventTypes.InputPromoted)?.data as { inputId: string }).inputId).toBe(inputId)
    expect(await host.replay("ses_admit", 1)).toEqual(events.slice(1))
    host.close()
  })

  test("runs an injected tool only through the enforced registry runner", async () => {
    const calls: unknown[] = []
    const host = createEngineHost({
      model: scriptedModel([
        { kind: "tools", calls: [{ name: "echo", input: { value: "hello" } }] },
        { kind: "final", text: "echoed" },
      ]),
      toolDefinitions: [echoTool((input) => calls.push(input))],
    })
    await host.admit("ses_tool", "echo hello")
    const result = await host.run("ses_tool")
    expect(result.state).toBe("completed")
    expect(calls).toEqual([{ value: "hello" }])
    expect((await host.replay("ses_tool")).map((event) => event.type)).toContain(EventTypes.ToolExecuted)
    host.close()
  })

  test("provider failure lands exactly one terminal failure event", async () => {
    const host = createEngineHost({
      model: { async call() { throw new Error("provider unavailable") } },
      toolDefinitions: [],
    })
    await host.admit("ses_failed", "try")
    const result = await host.run("ses_failed")
    expect(result).toEqual(expect.objectContaining({ state: "failed", reason: "provider_error" }))
    const terminal = (await host.replay("ses_failed")).filter((event) => event.type === EventTypes.RunFailed)
    expect(terminal).toHaveLength(1)
    host.close()
  })

  test("lifecycle is explicit, idempotent, and fail-closed after close", async () => {
    const host = createEngineHost({
      model: scriptedModel([{ kind: "final", text: "unused" }]),
      toolDefinitions: [echoTool()],
    })
    expect(host.toolSchemas().map((tool) => tool.name)).toEqual(["echo"])
    host.close()
    host.close()
    expect(host.closed).toBeTrue()
    expect(host.replay("ses_closed")).rejects.toThrow("engine_host_closed")
    expect(() => host.toolSchemas()).toThrow("engine_host_closed")
  })

  test("close refuses to race an active run", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const host = createEngineHost({
      model: {
        async call() {
          entered.resolve()
          await release.promise
          return { kind: "final", text: "done" }
        },
      },
      toolDefinitions: [],
    })
    await host.admit("ses_busy", "wait")
    const running = host.run("ses_busy")
    await entered.promise
    expect(() => host.close()).toThrow("engine_host_busy")
    release.resolve()
    expect((await running).state).toBe("completed")
    host.close()
  })

  test("ambiguous tool composition is refused before the store is exposed", () => {
    expect(() => createEngineHost({
      model: scriptedModel([{ kind: "final", text: "unused" }]),
      toolDefinitions: [echoTool(), echoTool()],
    })).toThrow("engine_host_duplicate_tool")
  })

  test("the composition source owns no network, filesystem, process, or kernel implementation", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(source).not.toMatch(/from\s+["'](?:node:(?:fs|net|http|https|child_process)|@abdo\/(?:kernel|egress))/)
  })
})
