import { expect, test } from "bun:test"
import { decodeTransportFrame } from "@abdo/transport-contracts"
import { LocalAgentClient } from "../src"
test("creates versioned resumable local requests", () => {
  const client = new LocalAgentClient("s1")
  expect(decodeTransportFrame(client.submit("hello"))).toMatchObject({ kind: "submit", requestId: "s1:1" })
  client.observe(7)
  expect(decodeTransportFrame(client.resume())).toMatchObject({ kind: "events", afterSequence: 7 })
})
