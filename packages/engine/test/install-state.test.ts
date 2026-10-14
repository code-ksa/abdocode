import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensureStateRoot, isStoreInstall, stateRootFor } from "../src/install-state"

// 10-12 — نسخةُ متجر مايكروسوفت (MSIX) تُثبَّت في WindowsApps للقراءة فقط؛ حالةُ المحرّك تذهب إلى %LOCALAPPDATA%\AbdoCode\state.

const STORE = "C:\\Program Files\\WindowsApps\\abdocode.AbdoCode_4.0.152.0_x64__mjcjrexgt3ap6\\payload"
const NSIS = "C:\\Users\\u\\AppData\\Local\\AbdoCode\\payload"

describe("أين تُكتب حالةُ المحرّك", () => {
  test("المثبِّتُ العاديّ: مجلّدُ الـexe كما كان", () => {
    expect(isStoreInstall(NSIS)).toBe(false)
    expect(stateRootFor(NSIS, {})).toBe(resolve(NSIS))
  })
  test("المتجر: LOCALAPPDATA\\AbdoCode\\state، والمجلّدُ الصريح يغلب، والفارغُ لا يُحسب صريحاً", () => {
    expect(isStoreInstall(STORE)).toBe(true)
    expect(isStoreInstall("C:/Program Files/WindowsApps/x/payload")).toBe(true)
    expect(stateRootFor(STORE, { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe(resolve("C:\\Users\\u\\AppData\\Local", "AbdoCode", "state"))
    expect(stateRootFor(STORE, { LOCALAPPDATA: "C:\\L", ABDO_CODE_STATE_DIR: "D:\\explicit" })).toBe(resolve("D:\\explicit"))
    expect(stateRootFor(STORE, { LOCALAPPDATA: "C:\\L", ABDO_CODE_STATE_DIR: "  " })).toBe(resolve("C:\\L", "AbdoCode", "state"))
    expect(stateRootFor(NSIS, { ABDO_CODE_STATE_DIR: "D:\\explicit" })).toBe(resolve("D:\\explicit"))
  })
  test("مجلّدُ المتجر يُنشأ قبل أوّل كتابة؛ ومجلّدُ المثبِّت لا يُلمس", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-state-"))
    try {
      const state = join(dir, "AbdoCode", "state")
      expect(ensureStateRoot(STORE, state)).toBe(state)
      expect(existsSync(state)).toBe(true)
      const other = join(dir, "untouched")
      expect(ensureStateRoot(NSIS, other)).toBe(other)
      expect(existsSync(other)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("المحرّكُ وخادمُ البحث يأخذان الحالةَ من هنا، والقشرةُ تمرّرها في المتجر", () => {
    const root = resolve(import.meta.dir, "..")
    expect(readFileSync(join(root, "src", "cli.ts"), "utf8")).toContain("const STATE_ROOT = ensureStateRoot(ROOT, stateRootFor(ROOT, process.env))")
    expect(readFileSync(join(root, "src", "google-search-mcp.ts"), "utf8")).toContain("const STATE_ROOT = ensureStateRoot(ROOT, stateRootFor(ROOT, process.env))")
    const shell = readFileSync(join(root, "..", "desktop", "src-tauri", "src", "main.rs"), "utf8")
    expect(shell).toContain("release_check::store_managed(),")
    expect(shell).toContain('std::env::set_var("ABDO_CODE_STATE_DIR", dir);')
  })
})
