import { describe, expect, test } from "bun:test"
import { admitCredentials, type AdmissionDeps, type AdmissionProvider } from "../src/credential-admission"

/**
 * S11 (2026-09-18) — بوّابةُ الاعتماد عند القبول: مقيس على المثبّتات ستّةُ أدوارٍ ماتت قبل أوّل أداة
 * بـ«اعتماد المزوّد غير متاح» لأنّ السلّم/الرؤية يشيران إلى مزوّدٍ مقبضُه غائبٌ في خزنة ذلك التطبيق.
 */
const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

const CATALOG: Record<string, AdmissionProvider> = {
  ollama: { id: "ollama", local: true },
  deepseek: { id: "deepseek", local: false, vaultKey: "abdocode-deepseek" },
  nvidia: { id: "nvidia", local: false, vaultKey: "abdocode-nvidia" },
  qwen: { id: "qwen", local: false, vaultKey: "abdocode-qwen" },
  free: { id: "free", local: false },
}

const deps = (vault: readonly string[], probes: string[] = []): AdmissionDeps => ({
  parseRef: (ref) => { const i = ref.indexOf("/"); return i > 0 && CATALOG[ref.slice(0, i)] !== undefined ? { provider: ref.slice(0, i) } : undefined },
  providerOf: (id) => CATALOG[id],
  hasCredential: async (provider) => { probes.push(provider); if (provider === "qwen") throw new Error("vault worker crashed"); return vault.includes(provider) },
})

describe("S11 — الاعتمادُ يُفحص عند القبول قبل أوّل نداء", () => {
  test("كلُّ المقابض حاضرة أو غيرُ لازمة ⇦ لا إشعارَ ولا تغيير؛ والمحلّيّ ومن لا مقبضَ له لا يُسألان", async () => {
    const probes: string[] = []
    const r = await admitCredentials({ selected: "deepseek/deepseek-v4-flash", ladder: ["ollama/qwen3", "free/x", "deepseek/deepseek-v4-pro"], vision: "deepseek/vision" }, deps(["deepseek"], probes))
    expect(r.selected).toBe("deepseek/deepseek-v4-flash")
    expect(r.ladder).toEqual(["ollama/qwen3", "free/x", "deepseek/deepseek-v4-pro"])
    expect(r.vision).toBe("deepseek/vision")
    expect(r.missing).toEqual([])
    expect(r.notice).toBeUndefined()
    expect(r.failure).toBeUndefined()
    // مزوّدٌ واحد يُسأل مرّةً واحدة مهما تكرّر في السلّم والرؤية.
    expect(probes).toEqual(["deepseek"])
  })

  test("نموذجُ الدور بلا مقبض ⇦ يُخطّى بإشعارٍ واحد يسمّي المقبض، ويمضي الدور على أوّل درجةٍ حاضرة؛ والسلّم يُصفّى بترتيبه", async () => {
    const r = await admitCredentials({ selected: "nvidia/nemotron", ladder: ["nvidia/nemotron", "deepseek/deepseek-v4-flash", "ollama/qwen3"] }, deps(["deepseek"]))
    expect(r.selected).toBe("deepseek/deepseek-v4-flash")
    expect(r.ladder).toEqual(["deepseek/deepseek-v4-flash", "ollama/qwen3"])
    expect(r.missing).toEqual([{ ref: "nvidia/nemotron", provider: "nvidia", handle: "abdocode-nvidia" }])
    expect(r.notice).toContain("nvidia: abdocode-nvidia")
    expect(r.notice).toContain("تُخطّى: nvidia/nemotron")
    expect(r.notice).toContain("يمضي الدور على deepseek/deepseek-v4-flash")
    expect(r.failure).toBeUndefined()
  })

  test("الرؤيةُ بلا مقبض ⇦ تُخطّى وحدها والدورُ يمضي على نموذجه، والإشعارُ يقول إنّ الرؤية على نموذج الدور", async () => {
    const r = await admitCredentials({ selected: "ollama/qwen3", ladder: [], vision: "nvidia/vision" }, deps([]))
    expect(r.selected).toBe("ollama/qwen3")
    expect(r.vision).toBeUndefined()
    expect(r.notice).toContain("nvidia: abdocode-nvidia")
    expect(r.notice).toContain("والرؤيةُ على نموذج الدور")
    expect(r.notice).not.toContain("يمضي الدور على")
    expect(r.failure).toBeUndefined()
  })

  test("لا نموذجَ يبقى ⇦ رفضٌ مسمّى يسرد المقابض الغائبة كلَّها بلا تكرار؛ وفشلُ سؤال الخزنة غيابٌ لا إذن", async () => {
    const r = await admitCredentials({ selected: "qwen/qwen-max", ladder: ["nvidia/a", "nvidia/b"], vision: "qwen/vision" }, deps(["deepseek"]))
    expect(r.selected).toBeUndefined()
    expect(r.ladder).toEqual([])
    expect(r.vision).toBeUndefined()
    expect(r.notice).toBeUndefined()
    expect(r.failure).toContain("لا نموذجَ له اعتمادٌ في الخزنة")
    expect(r.failure).toContain("qwen: abdocode-qwen")
    expect(r.failure).toContain("nvidia: abdocode-nvidia")
    expect(r.failure!.match(/abdocode-nvidia/gu)).toHaveLength(1)
    // التوأمُ الإيجابيّ: الخزنةُ الحاضرة تقلب الحكم.
    expect((await admitCredentials({ selected: "nvidia/a", ladder: [] }, deps(["nvidia"]))).failure).toBeUndefined()
  })

  test("مرجعٌ لا يُحلّ يُسمّى غياباً لا يُبتلع", async () => {
    const r = await admitCredentials({ selected: "ghost/x", ladder: ["ollama/qwen3"] }, deps([]))
    expect(r.selected).toBe("ollama/qwen3")
    expect(r.missing[0]).toEqual({ ref: "ghost/x", provider: "ghost/x", handle: "مرجعٌ لا يُحلّ" })
  })

  test("cli.ts يفحص عند القبول قبل أوّل نداء: الرفضُ المسمّى، الإشعارُ الواحد، تبديلُ النموذج، تصفيةُ السلّم، والرؤيةُ غيرُ المقبولة لا تُسلَك", () => {
    expect(cliSource).toContain("const admission = await admitCredentials(")
    expect(cliSource).toContain("{ parseRef: Providers.parseRef, providerOf: Providers.provider, hasCredential: (provider) => REACH.hasCredential(provider) },")
    expect(cliSource).toContain("if (admission.failure !== undefined) throw new Error(admission.failure)")
    expect(cliSource).toContain("if (admission.notice !== undefined) await emitEvent(turn.id, `⚠ ${admission.notice}`)")
    expect(cliSource).toContain("if (admission.selected !== undefined && admission.selected !== selectedModel.ref) selectedModel = selectionOf(admission.selected, selectedModel.lane) ?? selectedModel")
    expect(cliSource).toContain("const ladder = ownerRungs.filter((rung) => admission.ladder.includes(rung.ref))")
    expect(cliSource).toContain("shotRoute(visionAdmitted ? loadSettings() : { ...loadSettings(), visionModel: undefined })")
    // الترتيب جزءٌ من الميزة: القبولُ قبل بثّ model-route وقبل البوّابة الأمامية وأوّل ask.
    const at = cliSource.indexOf("const admission = await admitCredentials(")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(cliSource.indexOf('emit({ kind: "model-route", turnId: turn.id, lane: selectedModel.lane, ref: selectedModel.ref, ...(selectedModel.vision ? { vision: true } : {}) })', cliSource.indexOf("let selectedModel = turnSelection")))
    expect(at).toBeLessThan(cliSource.indexOf("const gateMode = parseGateMode(loadSettings().routerGate)"))
  })
})
