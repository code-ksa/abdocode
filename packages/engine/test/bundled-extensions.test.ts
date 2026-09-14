import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bundledRoot, listBundledExtensions } from "../src/bundled-extensions"

// الحزمُ المضمَّنة: القارئُ يصف ما يطابق عقدَ المانيفست ويُسقط ما لا يطابقه بسبب؛ والجذرُ أوّلُ مرشّحٍ موجود.
// والتوأمُ الإيجابيّ: مجلّدُ المستودع الحقيقيّ extensions/bundled يعطي كلَّ الحزم الإحدى والأربعين.

const REPO_BUNDLED = resolve(import.meta.dir, "..", "..", "..", "extensions", "bundled")

describe("قارئُ الحزم المضمَّنة", () => {
  test("الجذر: أوّلُ مرشّحٍ موجود؛ لا مرشّحَ ⇒ لا جذر ولا قائمة", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bundled-"))
    try {
      expect(bundledRoot([undefined, "", join(dir, "missing"), dir])).toBe(resolve(dir))
      expect(bundledRoot([join(dir, "missing")])).toBeUndefined()
      expect(listBundledExtensions(undefined)).toEqual({ root: undefined, entries: [], dropped: [] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("حزمةٌ صالحة تُوصف؛ حزمةٌ بلا مانيفست أو بمعرّفٍ مخالف أو بلا مهارةٍ صالحة تُسقَط بسبب", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bundled-"))
    try {
      const good = join(dir, "good-pack")
      mkdirSync(join(good, "skills", "one"), { recursive: true })
      writeFileSync(join(good, "abdocode-extension.json"), JSON.stringify({ schemaVersion: 1, id: "good-pack", name: "Good", version: "1.0.0", description: "d", skills: ["skills/one", "skills/none"], mcpServers: [] }))
      writeFileSync(join(good, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: first skill\n---\nbody\n")
      writeFileSync(join(good, "FEATURES.md"), "# x\n\n- **النوع**: knowledge-work\n")
      mkdirSync(join(dir, "no-manifest"))
      const badId = join(dir, "bad-id"); mkdirSync(badId)
      writeFileSync(join(badId, "abdocode-extension.json"), JSON.stringify({ schemaVersion: 1, id: "other", name: "x", version: "1", description: "d", skills: [], mcpServers: [] }))
      const noSkill = join(dir, "no-skill"); mkdirSync(join(noSkill, "skills", "s"), { recursive: true })
      writeFileSync(join(noSkill, "abdocode-extension.json"), JSON.stringify({ schemaVersion: 1, id: "no-skill", name: "x", version: "1", description: "d", skills: ["skills/s"], mcpServers: [] }))
      writeFileSync(join(noSkill, "skills", "s", "SKILL.md"), "---\nname: Not-A-Slug\n---\n")
      const extra = join(dir, "extra-key"); mkdirSync(extra)
      writeFileSync(join(extra, "abdocode-extension.json"), JSON.stringify({ schemaVersion: 1, id: "extra-key", name: "x", version: "1", description: "d", skills: [], mcpServers: [], agents: [] }))
      const listing = listBundledExtensions(dir)
      expect(listing.entries.map((e) => e.id)).toEqual(["good-pack"])
      expect(listing.entries[0]!.skills).toEqual([{ id: "one", description: "first skill" }])
      expect(listing.entries[0]!.kind).toBe("knowledge-work")
      expect(listing.entries[0]!.path).toBe(good)
      expect(listing.dropped.sort()).toEqual(["bad-id: id", "extra-key: manifest shape", "no-manifest: no manifest", "no-skill: no valid skill"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("التوأمُ الإيجابيّ: مجلّدُ المستودع يعطي الحزمَ الإحدى والأربعين بلا إسقاط", () => {
    const listing = listBundledExtensions(bundledRoot([REPO_BUNDLED]))
    expect(listing.dropped).toEqual([])
    expect(listing.entries.length).toBe(41)
    for (const id of ["code-review", "design", "abdo-security", "abdo-skills", "rust-lsp"]) expect(listing.entries.some((e) => e.id === id)).toBe(true)
    expect(listing.entries.find((e) => e.id === "abdo-skills")!.skills.some((s) => s.id === "morning")).toBe(true)
  })
})
