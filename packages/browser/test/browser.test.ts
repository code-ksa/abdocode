/**
 * Batch 6 GATES — S60 to S70, in the owner's binding order.
 *
 * Everything runs against a fake provider, which is the point of Sprint 60: the
 * agent's logic never knows which browser is underneath, so the same tests
 * drive two "providers" and get the same decisions.
 */
import { describe, expect, test } from "bun:test"
import {
  BrowserDaemon,
  type AxNode,
  type BrowserProvider,
  type ConsoleMessage,
  type DomNode,
  type NetworkEvent,
  type StorageState,
} from "../src/provider"
import {
  askPage,
  clickAtGuarded,
  clickSemantic,
  describeBidi,
  fillAndVerify,
  handleDialog,
  prepareUpload,
  resolveTarget,
} from "../src/page"
import { EscalationLedger, judgeConsole, judgeNetwork } from "../src/observe"
import { SessionRegistry } from "../src/sessions"

const ax = (role: string, name: string, over: Partial<AxNode> = {}): AxNode => ({
  nodeId: `${role}:${name}`,
  role,
  name,
  children: [],
  ...over,
})

const TREE: AxNode = ax("document", "Invoices", {
  children: [
    ax("button", "Save", { box: { x: 100, y: 200, width: 80, height: 30 } }),
    ax("button", "Delete"),
    ax("button", "Delete"),
    ax("textbox", "Customer name", { value: "" }),
    ax("button", "Archive", { disabled: true }),
  ],
})

const DOM: DomNode = {
  nodeId: "root",
  tag: "body",
  attributes: {},
  children: [{ nodeId: "h1", tag: "h1", attributes: {}, text: "Invoice 4102 saved", children: [] }],
}

/** A fake provider. Two of these with different names prove Sprint 60. */
function fake(name: "playwright" | "cdp", state: { values?: Record<string, string>; tree?: AxNode } = {}) {
  const values: Record<string, string> = state.values ?? {}
  const clicks: string[] = []
  const pixels: { x: number; y: number }[] = []
  let storage: StorageState = { cookies: [], origins: [] }
  const provider: BrowserProvider = {
    name,
    async navigate() {},
    async currentUrl() {
      return "https://app.example/invoices/4102"
    },
    async dom() {
      return DOM
    },
    async accessibility() {
      return state.tree ?? TREE
    },
    async clickNode(nodeId) {
      clicks.push(nodeId)
    },
    async typeInto(nodeId, text) {
      values[nodeId] = text
    },
    async readValue(nodeId) {
      return values[nodeId]
    },
    async screenshot() {
      return new Uint8Array()
    },
    async consoleMessages() {
      return []
    },
    async networkEvents() {
      return []
    },
    async storageState() {
      return storage
    },
    async restoreStorage(s) {
      storage = s
    },
    async clickAt(x, y) {
      pixels.push({ x, y })
    },
    async close() {},
  }
  return { provider, clicks, pixels, values, setStorage: (s: StorageState) => (storage = s) }
}

describe("S60 GATE — swapping the provider changes nothing above the seam", () => {
  test("the same agent logic makes the same decisions on two providers", async () => {
    const results = []
    for (const name of ["playwright", "cdp"] as const) {
      const { provider, clicks } = fake(name)
      const outcome = await clickSemantic(provider, { role: "button", name: "Save" })
      const answer = await askPage(provider, { kind: "text_present", text: "Invoice 4102 saved" })
      results.push({ outcome, answer, clicks: [...clicks] })
    }
    expect(results[1]).toEqual(results[0]!)
  })
})

describe("S61 GATE — a crash does not cost the login", () => {
  test("recovery restores storage BEFORE navigating, and says so", async () => {
    const order: string[] = []
    const storage: StorageState = {
      cookies: [{ name: "session", value: "abc", domain: "app.example" }],
      origins: [{ origin: "https://app.example", localStorage: { token: "t" } }],
    }
    const launch = async (): Promise<BrowserProvider> => {
      const { provider } = fake("playwright")
      return {
        ...provider,
        async storageState() {
          return storage
        },
        async restoreStorage() {
          order.push("restore")
        },
        async navigate() {
          order.push("navigate")
        },
      }
    }
    const daemon = new BrowserDaemon({ sessionId: "s1", launch, now: () => 1 })
    await daemon.start()
    await daemon.capture()
    daemon.markCrashed("the browser died")
    expect(daemon.status().state).toBe("crashed")

    const recovery = await daemon.recover()
    expect(recovery.recovered).toBe(true)
    // restore first: navigating first lands on the login page and then applies
    // cookies to it, which looks like it worked
    expect(order).toEqual(["restore", "navigate"])
    expect(recovery.why).toContain("BEFORE navigating")
    expect(daemon.status().crashes).toBe(1)
  })

  test("with no snapshot, recovery says the agent must log in again rather than pretending", async () => {
    const daemon = new BrowserDaemon({ sessionId: "s1", launch: async () => fake("cdp").provider })
    await daemon.start()
    daemon.markCrashed("died before any capture")
    const recovery = await daemon.recover()
    expect(recovery.recovered).toBe(false)
    expect(recovery.why).toContain("authenticate again")
  })
})

describe("S62/S63 GATE — the page is read from structure, and roles survive a restyle", () => {
  test("questions are answered from the DOM and the accessibility tree", async () => {
    const { provider } = fake("playwright")
    const present = await askPage(provider, { kind: "text_present", text: "invoice 4102 SAVED" })
    expect(present).toEqual({ kind: "answered", value: true, from: "dom" })

    const state = await askPage(provider, { kind: "element_state", target: { role: "button", name: "Archive" } })
    expect(state).toEqual({ kind: "answered", value: false, from: "accessibility" })
  })

  test("an element that changed shape but not role or name is still targetable", () => {
    const restyled: AxNode = ax("document", "Invoices", {
      children: [
        // different nodeId, different box, different everything visual
        ax("button", "Save", { nodeId: "v2-node-9999", box: { x: 900, y: 12, width: 200, height: 60 } }),
      ],
    })
    const before = resolveTarget(TREE, { role: "button", name: "Save" })
    const after = resolveTarget(restyled, { role: "button", name: "Save" })
    expect(before.kind).toBe("resolved")
    expect(after.kind).toBe("resolved")
  })

  test("two matching elements are AMBIGUOUS, never the first one", () => {
    const resolution = resolveTarget(TREE, { role: "button", name: "Delete" })
    expect(resolution.kind).toBe("ambiguous")
    if (resolution.kind === "ambiguous") expect(resolution.why).toContain("deletes the wrong row")
    // saying which one is allowed
    expect(resolveTarget(TREE, { role: "button", name: "Delete", nth: 1 }).kind).toBe("resolved")
  })

  test("a miss reports the nearest names, so the next step is not a screenshot", () => {
    const resolution = resolveTarget(TREE, { role: "button", name: "Sav" })
    expect(resolution.kind).toBe("not_found")
    if (resolution.kind === "not_found") expect(resolution.nearest).toContain("Save")
  })
})

describe("S64/S68 GATE — semantic actions, and Arabic that arrives intact", () => {
  test("a semantic click reaches the node, and no pixel is touched", async () => {
    const { provider, clicks, pixels } = fake("playwright")
    const outcome = await clickSemantic(provider, { role: "button", name: "Save" })
    expect(outcome.kind).toBe("done")
    expect(clicks).toEqual(["button:Save"])
    expect(pixels).toEqual([])
  })

  test("a disabled element is refused rather than clicked into nothing", async () => {
    const { provider, clicks } = fake("playwright")
    const outcome = await clickSemantic(provider, { role: "button", name: "Archive" })
    expect(outcome.kind).toBe("failed")
    expect(clicks).toEqual([])
  })

  test("Arabic input is verified codepoint by codepoint on the RAW string", async () => {
    const arabic = "شركة المصانع المتحدة — فاتورة رقم ٤١٠٢ 🙂"
    const { provider } = fake("playwright")
    const outcome = await fillAndVerify(provider, { role: "textbox", name: "Customer name" }, arabic)
    expect(outcome.kind).toBe("done")
    expect(outcome.readBack).toBe(arabic)
  })

  test("a pipeline that mangles the text is CAUGHT, with the codepoint named", async () => {
    const arabic = "فاتورة"
    const { provider } = fake("playwright")
    // a bidi-unaware serialiser that reverses the string: the classic failure
    const mangling: BrowserProvider = {
      ...provider,
      async readValue() {
        return [...arabic].reverse().join("")
      },
    }
    const outcome = await fillAndVerify(mangling, { role: "textbox", name: "Customer name" }, arabic)
    expect(outcome.kind).toBe("mismatch")
    expect(outcome.why).toContain("differs at codepoint")
  })

  test("bidi control marks are named rather than printed invisibly", () => {
    expect(describeBidi("abc‏def")).toEqual(["U+200F"])
    expect(describeBidi("plain")).toEqual([])
  })
})

describe("S65 GATE — a console error blocks PASS unless classified AND justified", () => {
  const errors: ConsoleMessage[] = [
    { level: "error", text: "TypeError: Cannot read properties of undefined (reading 'id')", at: 1 },
    { level: "warning", text: "deprecated API", at: 2 },
  ]

  test("an unclassified error blocks", () => {
    const verdict = judgeConsole(errors)
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("the page threw while the agent was about to call this done")
  })

  test("a classified error with a real reason is excused", () => {
    const verdict = judgeConsole(errors, [
      {
        match: "Cannot read properties of undefined",
        disposition: "known_benign",
        why: "third-party analytics script races the page unload and cannot affect the form",
      },
    ])
    expect(verdict.allowed).toBe(true)
    expect(verdict.excused[0]!.why).toContain("known_benign")
  })

  test("a catch-all excuse cannot be written — that is how this kind of gate dies", () => {
    const verdict = judgeConsole(errors, [{ match: "", disposition: "known_benign", why: "ok" }])
    expect(verdict.allowed).toBe(false)
  })

  test("a 404 counts as a failure — this is how a page 'works' in a screenshot and is broken for a user", () => {
    const events: NetworkEvent[] = [
      { url: "https://app.example/api/invoices", method: "GET", status: 200, at: 1 },
      { url: "https://app.example/assets/logo.png", method: "GET", status: 404, at: 2 },
    ]
    expect(judgeNetwork(events).allowed).toBe(false)
    expect(judgeNetwork(events, ["/assets/"]).allowed).toBe(true)
  })
})

describe("S66/S67 GATE — vision needs a recorded failure, coordinates need a live target", () => {
  test("vision is refused with no recorded semantic failure for THIS target", () => {
    const ledger = new EscalationLedger()
    const refused = ledger.mayUse("vision", "button:Save")
    expect(refused.allowed).toBe(false)
    expect(refused.why).toContain("recorded semantic failure")

    ledger.record({ rung: "semantic", target: "button:Save", failed: true, why: "no button named Save", at: 1 })
    expect(ledger.mayUse("vision", "button:Save").allowed).toBe(true)
  })

  test("a failure on one target does not licence pixels on another", () => {
    const ledger = new EscalationLedger()
    ledger.record({ rung: "semantic", target: "button:Save", failed: true, why: "not found", at: 1 })
    expect(ledger.mayUse("coordinates", "button:Delete").allowed).toBe(false)
  })

  test("leaning on the bottom of the ladder is reported as a selector problem", () => {
    const ledger = new EscalationLedger()
    for (let i = 0; i < 8; i++) ledger.record({ rung: "semantic", target: `t${i}`, failed: false, why: "ok", at: i })
    for (let i = 0; i < 2; i++) ledger.record({ rung: "coordinates", target: `t${i}`, failed: false, why: "ok", at: i })
    const habit = ledger.visionHabit()
    expect(habit.suspicious).toBe(true)
    expect(habit.why).toContain("the selectors are wrong")
  })

  test("a coordinate click is refused when the element moved after the coordinate was computed", async () => {
    const { provider, pixels } = fake("playwright")
    const inside = await clickAtGuarded(provider, { x: 140, y: 210, expect: { role: "button", name: "Save" } })
    expect(inside.kind).toBe("clicked")
    expect(pixels).toEqual([{ x: 140, y: 210 }])

    // a banner loaded and pushed the button down
    const moved = await clickAtGuarded(provider, { x: 140, y: 900, expect: { role: "button", name: "Save" } })
    expect(moved.kind).toBe("refused")
    if (moved.kind === "refused") expect(moved.why).toContain("something moved after the coordinate was computed")
    expect(pixels).toHaveLength(1)
  })

  test("a coordinate click is refused when the element is gone entirely", async () => {
    const { provider } = fake("playwright", { tree: ax("document", "empty") })
    const outcome = await clickAtGuarded(provider, { x: 1, y: 1, expect: { role: "button", name: "Save" } })
    expect(outcome.kind).toBe("refused")
  })
})

describe("S69 GATE — uploads and dialogs without a human", () => {
  test("a dialog with no declared policy BLOCKS rather than being dismissed", () => {
    const outcome = handleDialog("confirm", { handlers: {} })
    expect(outcome.kind).toBe("blocked")
    expect(outcome.why).toContain('silently answers "are you sure?"')
  })

  test("a declared policy handles it", () => {
    expect(handleDialog("file_chooser", { handlers: { file_chooser: "accept" } }).kind).toBe("handled")
  })

  test("an upload goes through the chooser, with a size bound", () => {
    expect(prepareUpload({ target: { role: "button", name: "Upload" }, files: [{ path: "a.pdf", bytes: 1000 }] }).kind).toBe("ready")
    const tooBig = prepareUpload({
      target: { role: "button", name: "Upload" },
      files: [{ path: "huge.iso", bytes: 5_000_000_000 }],
    })
    expect(tooBig.kind).toBe("refused")
  })
})

describe("S70 GATE — two users never see each other's session", () => {
  test("different users get different contexts", () => {
    let n = 0
    const registry = new SessionRegistry(() => 1)
    const a = registry.contextFor({ userId: "u1", projectId: "p1" }, () => `ctx_${++n}`)
    const b = registry.contextFor({ userId: "u2", projectId: "p1" }, () => `ctx_${++n}`)
    expect(a.kind).toBe("context")
    expect(b.kind).toBe("context")
    expect(registry.isolated({ userId: "u1", projectId: "p1" }, { userId: "u2", projectId: "p1" }).isolated).toBe(true)
  })

  test("the same user in two projects is also separated", () => {
    let n = 0
    const registry = new SessionRegistry(() => 1)
    registry.contextFor({ userId: "u1", projectId: "p1" }, () => `ctx_${++n}`)
    registry.contextFor({ userId: "u1", projectId: "p2" }, () => `ctx_${++n}`)
    expect(registry.all()).toHaveLength(2)
  })

  test("two contexts seeded from ONE storage state are not isolated, and the check catches it", () => {
    let n = 0
    const registry = new SessionRegistry(() => 1)
    registry.contextFor({ userId: "u1", projectId: "p1" }, () => `ctx_${++n}`)
    registry.contextFor({ userId: "u2", projectId: "p1" }, () => `ctx_${++n}`)
    const shared = {
      sessionId: "s",
      url: "https://app.example",
      storage: { cookies: [{ name: "session", value: "SAME", domain: "app.example" }], origins: [] },
      at: 1,
    }
    registry.remember({ userId: "u1", projectId: "p1" }, shared)
    registry.remember({ userId: "u2", projectId: "p1" }, shared)
    const verdict = registry.isolated({ userId: "u1", projectId: "p1" }, { userId: "u2", projectId: "p1" })
    expect(verdict.isolated).toBe(false)
    expect(verdict.why).toContain("not separate sessions")
  })

  test("an empty half of a key is refused — it would collapse two users into one", () => {
    const registry = new SessionRegistry(() => 1)
    expect(registry.contextFor({ userId: "", projectId: "p1" }, () => "ctx").kind).toBe("refused")
  })

  test("a session with no snapshot returns UNDEFINED storage, not an empty one", () => {
    const registry = new SessionRegistry(() => 1)
    registry.contextFor({ userId: "u1", projectId: "p1" }, () => "ctx")
    // an empty storage state restores successfully and leaves the agent logged
    // out while believing it recovered
    expect(registry.storageFor({ userId: "u1", projectId: "p1" })).toBeUndefined()
  })
})
