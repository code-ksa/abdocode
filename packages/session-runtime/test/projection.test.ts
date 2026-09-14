import { describe, expect, test } from "bun:test"
import { EventTypes, projectAssistantMessages } from "../src/index"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })
const started = (requestId: string, attempt = 1) => ev(EventTypes.ModelRequestStarted, { requestId, attempt })
const batch = (requestId: string, text: string) => ev(EventTypes.MessageDeltaBatch, { requestId, text })
const finalMsg = (text: string) => ev(EventTypes.MessageAppended, { role: "assistant", text })

describe("projectAssistantMessages", () => {
  test("a completed turn: authoritative message text, status completed, final true", () => {
    const events = [started("r1"), batch("r1", "Hel"), batch("r1", "lo"), finalMsg("Hello"), ev(EventTypes.RunCompleted, {})]
    const [m] = projectAssistantMessages(events)
    expect(m).toMatchObject({ requestId: "r1", status: "completed", text: "Hello", final: true })
  })

  test("a crash mid-stream (no message, no terminal) is interrupted, never final", () => {
    const events = [started("r1"), batch("r1", "partial answer")]
    const [m] = projectAssistantMessages(events)
    expect(m!.status).toBe("interrupted")
    expect(m!.final).toBe(false)
    expect(m!.text).toBe("partial answer") // kept for display/audit
  })

  test("a cancelled run marks the partial interrupted", () => {
    const events = [started("r1"), batch("r1", "half"), ev(EventTypes.RunCancelled, {})]
    expect(projectAssistantMessages(events)[0]!.status).toBe("interrupted")
  })

  test("a failed run marks the partial failed", () => {
    const events = [started("r1"), batch("r1", "half"), ev(EventTypes.RunFailed, {})]
    expect(projectAssistantMessages(events)[0]!.status).toBe("failed")
  })

  test("a superseded attempt's partial is interrupted, not merged into the winner", () => {
    const events = [
      started("r1", 1),
      batch("r1", "old partial"),
      started("r2", 2), // supersedes r1
      batch("r2", "new "),
      finalMsg("new answer"),
      ev(EventTypes.RunCompleted, {}),
    ]
    const projections = projectAssistantMessages(events)
    const r1 = projections.find((p) => p.requestId === "r1")!
    const r2 = projections.find((p) => p.requestId === "r2")!
    expect(r1.status).toBe("interrupted")
    expect(r1.final).toBe(false)
    expect(r2.status).toBe("completed")
    expect(r2.text).toBe("new answer")
  })

  test("the currently in-flight request may be streaming", () => {
    const events = [started("r1"), batch("r1", "typing")]
    const [m] = projectAssistantMessages(events, { activeRequestId: "r1" })
    expect(m!.status).toBe("streaming")
  })
})
