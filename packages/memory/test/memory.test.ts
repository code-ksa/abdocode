import { describe, expect, test } from "bun:test"
import {
  buildSummary,
  CredentialLeakError,
  FactStore,
  ProvenanceError,
} from "../src/index"

const PID = "prj_1"

describe("FactStore — provenance rules", () => {
  test("a fact starts as candidate", () => {
    const store = new FactStore()
    const f = store.record({ projectId: PID, kind: "project_fact", key: "db", value: "postgres" })
    expect(f.status).toBe("candidate")
  })

  test("cannot verify without a documented source", () => {
    const store = new FactStore()
    const f = store.record({ projectId: PID, kind: "project_fact", key: "db", value: "postgres" })
    expect(() => store.verify(f.id)).toThrow(ProvenanceError)
  })

  test("verifies with a source event id", () => {
    const store = new FactStore()
    const f = store.record({
      projectId: PID,
      kind: "known_error",
      key: "E123",
      value: "nginx 502",
      sourceEventIds: ["evt_abc"],
    })
    const v = store.verify(f.id)
    expect(v.status).toBe("verified")
    expect(v.verifiedAt).toBeGreaterThan(0)
  })
})

describe("FactStore — supersede keeps history", () => {
  test("old fact becomes superseded, not deleted; new links back", () => {
    const store = new FactStore()
    const v1 = store.record({ projectId: PID, kind: "architecture_decision", key: "storage", value: "sqlite" })
    const v2 = store.supersede(v1.id, {
      projectId: PID,
      kind: "architecture_decision",
      key: "storage",
      value: "postgres",
    })
    expect(store.get(v1.id)!.status).toBe("superseded")
    expect(store.get(v1.id)!.validUntil).toBeGreaterThan(0)
    expect(v2.supersedesId).toBe(v1.id)
    // only the new decision is "current"
    const current = store.current(PID, "architecture_decision")
    expect(current).toHaveLength(1)
    expect(current[0]!.value).toBe("postgres")
    // but history is preserved
    expect(store.all()).toHaveLength(2)
  })
})

describe("FactStore — credential references never hold raw secrets", () => {
  test("accepts a store reference", () => {
    const store = new FactStore()
    const f = store.record({
      projectId: PID,
      kind: "credential_reference",
      key: "mysql-root",
      value: "vault://production/mysql/root",
    })
    expect(f.value).toBe("vault://production/mysql/root")
  })

  test("rejects a raw secret value", () => {
    const store = new FactStore()
    expect(() =>
      store.record({ projectId: PID, kind: "credential_reference", key: "mysql-root", value: "hunter2-actual-password" }),
    ).toThrow(CredentialLeakError)
  })
})

describe("summary is a rebuildable view, not a source of truth", () => {
  test("summary recomputes identically and reflects only active facts", () => {
    const store = new FactStore()
    store.record({ projectId: PID, kind: "project_fact", key: "lang", value: "typescript", sourceEventIds: ["e1"] })
    const task = store.record({ projectId: PID, kind: "active_task", key: "T1", value: "ship slice 8" })
    const dec = store.record({ projectId: PID, kind: "architecture_decision", key: "d1", value: "event-sourced" })
    store.supersede(dec.id, { projectId: PID, kind: "architecture_decision", key: "d1", value: "event-sourced v2" })

    const a = buildSummary(PID, store.all())
    const b = buildSummary(PID, store.all()) // drop + rebuild
    expect(b).toEqual(a)

    expect(a.facts.map((i) => i.key)).toEqual(["lang"])
    expect(a.activeTasks.map((i) => i.value)).toEqual(["ship slice 8"])
    // superseded decision is gone; only the current one shows
    expect(a.decisions.map((i) => i.value)).toEqual(["event-sourced v2"])

    // retiring a task removes it from the rebuilt summary (facts stay the truth)
    store.invalidate(task.id)
    const c = buildSummary(PID, store.all())
    expect(c.activeTasks).toHaveLength(0)
  })
})
