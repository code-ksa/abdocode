// سلّمُ الانقطاع التلقائيّ (أمر المالك 2026-09-28): الأقدرُ المتاح بمفتاح أوّلاً، بلا الحاليّ ولا ما سقط، ولا نموذجَ بلا مفتاح.
import { describe, expect, test } from "bun:test"
import { climb } from "@abdo/providers"
import { FALLBACK_ORDER, fallbackLadder, spentRefs } from "../src/outage-ladder"

const parseRef = (ref: string) => { const slash = ref.indexOf("/"); return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : undefined }

describe("fallbackLadder", () => {
  test("the current model is rung 1 and the next rung is the strongest OTHER provider that has a key", () => {
    const keys = new Set(["nvidia", "openrouter"])
    const ladder = fallbackLadder("nvidia/nvidia/nemotron-3-ultra-550b-a55b", new Set(), { keyKnown: (p) => keys.has(p), parseRef })
    expect(ladder[0]!.ref).toBe("nvidia/nvidia/nemotron-3-ultra-550b-a55b")
    expect(ladder[1]!.ref).toBe("openrouter/anthropic/claude-sonnet-4.5")
    expect(ladder[2]!.ref).toBe("nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1")
    // لا مزوّدَ بلا مفتاح في السلّم
    expect(ladder.every((rung) => keys.has(parseRef(rung.ref)!.provider))).toBe(true)
    // climb يصعد درجةً واحدة = أقوى بديل
    const outcome = climb({ ref: ladder[0]!.ref, spentAttempts: [] }, ladder, { kind: "provider_unavailable", detail: "503", attemptId: "outage:x" })
    expect(outcome.kind).toBe("escalated")
    if (outcome.kind === "escalated") expect(outcome.to).toBe("openrouter/anthropic/claude-sonnet-4.5")
  })
  test("a rung that already fell this turn is excluded, so the ladder never returns to it", () => {
    const keys = new Set(["nvidia", "openrouter"])
    const exclude = new Set([...spentRefs(["outage:nvidia/nvidia/nemotron-3-ultra-550b-a55b"]), "nvidia/nvidia/nemotron-3-ultra-550b-a55b"])
    const ladder = fallbackLadder("openrouter/anthropic/claude-sonnet-4.5", exclude, { keyKnown: (p) => keys.has(p), parseRef })
    expect(ladder.map((r) => r.ref)).not.toContain("nvidia/nvidia/nemotron-3-ultra-550b-a55b")
    expect(ladder[1]!.ref).toBe("nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1")
  })
  test("no keys anywhere → empty ladder → the failure keeps its name (no invented model)", () => {
    expect(fallbackLadder("nvidia/nvidia/nemotron-3-super-120b-a12b", new Set(), { keyKnown: () => false, parseRef })).toEqual([])
  })
  test("the order is strongest-first and every ref parses", () => {
    expect(FALLBACK_ORDER[0]).toBe("nvidia/nvidia/nemotron-3-ultra-550b-a55b")
    expect(FALLBACK_ORDER.every((ref) => parseRef(ref) !== undefined)).toBe(true)
    expect(new Set(FALLBACK_ORDER).size).toBe(FALLBACK_ORDER.length)
  })
})

// الأسلاك: المحرّك يستعمل السلّمَ التلقائيّ حين يخلو سلّمُ المالك، ويستبعد ما سقط في الدور.
test("cli wires the fallback ladder behind the owner ladder with the spent rungs excluded", async () => {
  const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
  expect(source).toContain('const ladder = owner.length > 0 ? owner : fallbackLadder(sel.ref, new Set([...spentRefs(outageSpent), ...(outageRoute === undefined ? [] : [outageRoute.from])]), { keyKnown: providerKeyKnown, parseRef: (ref) => Providers.parseRef(ref) })')
  expect(source).toContain("const utilityCount = tailwindUtilityCount(after, definedCssClasses(PROJECT_DIR))")
})
