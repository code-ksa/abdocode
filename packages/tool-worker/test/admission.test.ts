import { describe, expect, test } from "bun:test"
import { adapterToolSpec, labelDigest, ToolAdmissionWorker } from "../src"

describe("Rust adapter admission client", () => {
  test("builds the five exact compiled names and effect classes", () => {
    expect(new TextDecoder().decode(labelDigest("abdo-write-adapter").slice(0, 18))).toBe("abdo-write-adapter")
    expect(adapterToolSpec("write").effect.tag).toBe("Mutate")
    expect(adapterToolSpec("git-read").effect.tag).toBe("Read")
    expect(adapterToolSpec("git-change").effect.tag).toBe("Mutate")
    expect(adapterToolSpec("package").effect.tag).toBe("Reach")
    expect(adapterToolSpec("network").effect.tag).toBe("Reach")
  })

  test("fails closed when the worker binary is absent", async () => {
    await expect(new ToolAdmissionWorker("Z:\\missing\\abdo-tool-worker.exe", 50).admit("write")).rejects.toThrow("tool_worker_unavailable")
  })
})
