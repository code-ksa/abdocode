import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RecipeCollector, RecipeStore, mergeRecipe, recipeBrief, recipeScript, setupTagsOf } from "../src/setup-recipes"

const ok = { ok: true } as never
const failed = { ok: false, reason: "exit 1" } as never
const noRedact = (t: string) => t

describe("a successful setup turn becomes a reusable recipe; ordinary commands never do", () => {
  test("nginx + pm2 receipts (exit 0) → one recipe with both steps in order, candidate on first sight", () => {
    const c = new RecipeCollector(noRedact)
    c.observe("run git status", "clean", ok)
    c.observe("run sudo cp site.conf /etc/nginx/sites-available/site", "", ok)
    c.observe("run sudo ln -s /etc/nginx/sites-available/site /etc/nginx/sites-enabled/site", "", ok)
    c.observe("run pm2 start dist/server.js --name site", "[PM2] started", ok)
    c.observe("run pm2 save", "saved", ok)
    const recipe = c.finish("C:/p/site", "linux", new Date("2026-09-13T10:00:00Z"))
    expect(recipe).toBeDefined()
    expect(recipe!.tags.slice(0, 2)).toEqual(["nginx", "pm2"])
    expect(recipe!.slug.startsWith("nginx-pm2-")).toBe(true)
    expect(recipe!.steps.map((s) => s.command)).toEqual([
      "sudo cp site.conf /etc/nginx/sites-available/site",
      "sudo ln -s /etc/nginx/sites-available/site /etc/nginx/sites-enabled/site",
      "pm2 start dist/server.js --name site",
      "pm2 save",
    ])
    expect(recipe!.status).toBe("candidate")
    expect(recipeScript(recipe!)).toContain("set -euo pipefail")
  })
  test("twin: a failed pm2 receipt, a lone global install, and plain commands produce no recipe", () => {
    const c = new RecipeCollector(noRedact)
    c.observe("run pm2 start app.js", "error: script not found", failed)
    c.observe("run ls -la", "…", ok)
    expect(c.finish("C:/p/a")).toBeUndefined()
    const lone = new RecipeCollector(noRedact)
    lone.observe("run npm i -g typescript", "added 1", ok)
    expect(lone.finish("C:/p/a")).toBeUndefined()
  })
  test("secrets are redacted before a step is kept, and a step that still looks redacted is dropped", () => {
    const c = new RecipeCollector((t) => t.replace(/sk-[a-z0-9]+/giu, "[REDACTED]"))
    c.observe("run docker login -p sk-abc123", "ok", ok)
    c.observe("run docker compose up -d", "ok", ok)
    expect(c.finish("C:/p/a")!.steps.map((s) => s.command)).toEqual(["docker compose up -d"])
  })
  test("tags: flutter/expo/swift scaffolds count as strong setup steps", () => {
    expect(setupTagsOf("flutter create myapp")).toEqual(["flutter"])
    expect(setupTagsOf("npx create-expo-app shop")).toEqual(["expo"])
    expect(setupTagsOf("swift package init --type executable")).toEqual(["swift"])
    expect(setupTagsOf("cat README.md")).toEqual([])
  })
})

describe("store on disk at user level: second project verifies, brief only when the user mentions a tag", () => {
  test("save → merge across projects → verified; forget removes json and script", () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-recipes-"))
    const store = new RecipeStore(root)
    const c = new RecipeCollector(noRedact)
    c.observe("run pm2 start server.js", "ok", ok)
    c.observe("run pm2 save", "ok", ok)
    const first = store.save(c.finish("C:/p/site", "win32")!)
    expect(first.status).toBe("candidate")
    expect(existsSync(join(store.dir, `${first.slug}.ps1`))).toBe(true)
    expect(readFileSync(join(store.dir, `${first.slug}.ps1`), "utf8")).toContain("$ErrorActionPreference = 'Stop'")
    const again = new RecipeCollector(noRedact)
    again.observe("run pm2 start server.js", "ok", ok)
    again.observe("run pm2 save", "ok", ok)
    const second = store.save(again.finish("C:/p/shop", "win32")!)
    expect(second.slug).toBe(first.slug)
    expect(second.status).toBe("verified")
    expect(second.uses).toBe(2)
    expect(second.projects).toEqual(["C:/p/site", "C:/p/shop"])
    expect(recipeBrief(store.all(), "ركّب pm2 للمتجر الجديد")).toContain(first.slug)
    expect(recipeBrief(store.all(), "اكتب صفحة تواصل")).toBe("")
    expect(store.forget(first.slug)).toBe(true)
    expect(store.all()).toHaveLength(0)
  })
  test("merge keeps the same project as candidate (one project is not evidence of reuse)", () => {
    const c = new RecipeCollector(noRedact)
    c.observe("run docker compose up -d", "ok", ok)
    const r = c.finish("C:/p/a")!
    expect(mergeRecipe(r, r).status).toBe("candidate")
  })
})
