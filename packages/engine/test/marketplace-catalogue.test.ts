// السوق (م6، أمر المالك 2026-09-14): البذرةُ مثبَّتةٌ إلى كوميت وبصمة، والدمجُ يرفض غيرَ المثبَّت، والواجهةُ تمرّ بمسار التنزيل المتحقِّق.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MARKETPLACE_CATALOGUE, MARKETPLACE_INDEX_URL, mergeMarket, validMarketEntry } from "../../desktop/ui/marketplace-catalogue.js"

const ui = (name: string) => readFileSync(resolve(import.meta.dir, "../../desktop/ui", name), "utf8")
const rust = (name: string) => readFileSync(resolve(import.meta.dir, "../../desktop/src-tauri/src", name), "utf8")
const PINNED = /^https:\/\/raw\.githubusercontent\.com\/code-ksa\/[\w.-]+\/[0-9a-f]{40}\/[\w./-]+\.json$/u

describe("marketplace seed", () => {
  test("every seed entry is commit-pinned to code-ksa with a SHA-256 and a unique slug id", () => {
    expect(MARKETPLACE_CATALOGUE.length).toBeGreaterThanOrEqual(2)
    const ids = new Set<string>()
    for (const e of MARKETPLACE_CATALOGUE) {
      expect(validMarketEntry(e)).toBe(true)
      expect(e.url).toMatch(PINNED)
      expect(e.url).toContain(`/${e.commit}/`)
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(e.nameAr.length).toBeGreaterThan(0)
      expect(e.descriptionAr.length).toBeGreaterThan(0)
      expect(ids.has(e.id)).toBe(false); ids.add(e.id)
    }
    expect(MARKETPLACE_INDEX_URL).toBe("https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/marketplace.json")
  })
  test("the seed hashes equal the first-party download list for the same packages", () => {
    // القائمةُ القديمة (extension-downloads.js) تشير إلى كوميت أقدم بالبصمة نفسها — الملفّان لم يتغيّرا بين الكوميتين (قيس 09-14 بتنزيلٍ وهاش).
    const legacy = ui("extension-downloads.js")
    for (const e of MARKETPLACE_CATALOGUE) expect(legacy).toContain(e.sha256)
  })
})

describe("mergeMarket", () => {
  const commit = "70a181f31a8ecd9c2ee3a3629adb3f22033d3587"
  const sha = "a".repeat(64)
  const remote = (over: Record<string, unknown>) => ({ id: "new-pack", name: "New", kind: "skills", url: `https://raw.githubusercontent.com/code-ksa/abdocode-addons/${commit}/release/new.json`, sha256: sha, skills: ["x"], tags: [], ...over })
  test("a valid remote entry is added and a remote entry with a seed id replaces the seed (positive twin)", () => {
    const merged = mergeMarket(MARKETPLACE_CATALOGUE, [remote({}), remote({ id: "abdo-workflow", name: "Workflows v2" })])
    expect(merged.length).toBe(MARKETPLACE_CATALOGUE.length + 1)
    expect(merged.find((e) => e.id === "abdo-workflow")?.name).toBe("Workflows v2")
    expect(merged.some((e) => e.id === "new-pack")).toBe(true)
  })
  test("unpinned, foreign-origin, bad-sha, bad-kind and bad-id remote entries are dropped", () => {
    const bad = [
      remote({ url: "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/new.json" }),
      remote({ url: `https://raw.githubusercontent.com/evil/abdocode-addons/${commit}/release/new.json` }),
      remote({ url: `https://evil.example/code-ksa/abdocode-addons/${commit}/release/new.json` }),
      remote({ sha256: "abc" }),
      remote({ kind: "binary" }),
      remote({ id: "Bad ID" }),
      null, "text", 42,
    ]
    const merged = mergeMarket(MARKETPLACE_CATALOGUE, bad as never)
    expect(merged.length).toBe(MARKETPLACE_CATALOGUE.length)
    expect(merged.some((e) => e.id === "new-pack")).toBe(false)
    expect(mergeMarket(MARKETPLACE_CATALOGUE, undefined as never).length).toBe(MARKETPLACE_CATALOGUE.length)
  })
})

describe("marketplace wiring", () => {
  test("the extensions panel draws the market for extensions and skills and downloads through the verifying native path", () => {
    const panel = ui("native-extension-settings.js")
    expect(panel).toContain('import { MARKETPLACE_CATALOGUE, mergeMarket } from "./marketplace-catalogue.js"')
    expect(panel).toContain("drawMarket(host,section);")
    expect(panel).toContain("api.bridge.invoke('marketplace_index')")
    expect(panel).toContain("api.bridge.invoke('extensions_download',{url:entry.url,sha256:entry.sha256,githubAuth:false})")
    expect(panel).toContain("mergeMarket(MARKETPLACE_CATALOGUE,index?.entries)")
    // التثبيتُ يمرّ بمراجعة الحزمة نفسِها — لا مسارَ تثبيتٍ مباشر من السوق
    expect(panel).toMatch(/marketInstall[\s\S]*?reviewPackage\(preview\)/u)
    expect(panel).not.toMatch(/marketInstall[\s\S]{0,400}extensions_install/u)
  })
  test("the native command is registered and the CSS carries the market classes", () => {
    const main = rust("main.rs")
    expect(main).toContain("mod marketplace;")
    expect(main).toContain("marketplace::marketplace_index,")
    const market = rust("marketplace.rs")
    expect(market).toContain("crate::extension_download::validate_url(&e.url, &e.sha256).is_ok()")
    expect(market).toContain('const ORIGIN: &str = "https://raw.githubusercontent.com/code-ksa/"')
    const css = ui("native-extension-settings.css")
    for (const cls of [".nex-market{", ".nex-market-bar{", ".nex-button.chip.on{", ".nex-market-installed{"]) expect(css).toContain(cls)
  })
})
