import { describe, expect, test } from "bun:test"
import { AdapterEffectLedger } from "../src"

const id = "01".repeat(16)
const digest = "ab".repeat(32)

describe("AdapterEffectLedger", () => {
  test("sends only bounded identities and digests to the Rust kernel", async () => {
    const seen: readonly string[][] = []
    const commands = seen as string[][]
    const ledger = new AdapterEffectLedger("abdo-kernel.exe", "journal.sqlite", async (argv) => {
      commands.push([...argv])
      const command = argv[2]
      if (command === "begin") return { exitCode: 0, stdout: "ADAPTER_LEDGER_BEGIN durable=dispatching\n", stderr: "" }
      return { exitCode: 0, stdout: "ADAPTER_LEDGER_SETTLE durable=verified\n", stderr: "" }
    })
    await ledger.begin(id, digest, 10)
    await ledger.settle(id, digest, "cd".repeat(32), 20)
    expect(seen[0]).toEqual(["abdo-kernel.exe", "adapter-ledger", "begin", "journal.sqlite", id, digest, "10"])
    expect(seen[1]?.includes("secret adapter output")).toBe(false)
  })

  test("parses startup reconciliation and refuses malformed bindings", async () => {
    const ledger = new AdapterEffectLedger("kernel", "journal", async () => ({
      exitCode: 0,
      stdout: "ADAPTER_LEDGER_RECOVER scanned=9 unresolved=2 marked_unknown=1 resumable_without_dispatch=0\n",
      stderr: "",
    }))
    expect(await ledger.recover(30)).toEqual({ scanned: 9, unresolved: 2, markedUnknown: 1, resumableWithoutDispatch: 0 })
    await expect(ledger.begin("not-an-id", digest, 10)).rejects.toThrow("adapter_ledger_invalid_binding")
  })

  test("fails closed when Rust does not durably acknowledge the phase", async () => {
    const ledger = new AdapterEffectLedger("kernel", "journal", async () => ({ exitCode: 1, stdout: "", stderr: "writer busy" }))
    await expect(ledger.begin(id, digest, 10)).rejects.toThrow("adapter_ledger_refused")
  })
})
