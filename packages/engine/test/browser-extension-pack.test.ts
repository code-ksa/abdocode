import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// 10-02 — the store packages built by pack.mjs, read from disk. Two measured gaps: the 0.6.6/0.6.7 fixes (autofilled fields,
// insertText for React-controlled fields) lived only in a desktop copy, never in the source the stores are built from; and the
// Firefox build declared `none` for data collection while it sends page content and the tab URL to the local app — AMO counts
// anything leaving the browser as transmission. `data_collection_permissions` is supported from Firefox 140 (Android 142).

const ROOT = resolve(import.meta.dir, "../../browser-bridge")

describe("browser extension store packages", () => {
  test("pack builds Chrome/Edge and Firefox manifests as the stores require, from the source that carries the latest fixes", () => {
    const out = mkdtempSync(join(tmpdir(), "abdo-ext-pack-"))
    try {
      const run = Bun.spawnSync(["node", "scripts/pack.mjs", "--deliver", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
      expect(run.exitCode).toBe(0)
      const firefox = JSON.parse(readFileSync(join(out, "unpacked", "firefox", "manifest.json"), "utf8"))
      const chrome = JSON.parse(readFileSync(join(out, "unpacked", "chrome-edge", "manifest.json"), "utf8"))
      expect(chrome.manifest_version).toBe(3)
      expect(chrome.background.service_worker).toBe("background.js")
      expect(chrome.version).toBe("0.6.8")
      expect(firefox.version).toBe(chrome.version)
      expect(firefox.background).toEqual({ scripts: ["background.js"] })
      expect(firefox.permissions).not.toContain("debugger")
      expect(firefox.browser_specific_settings.gecko.strict_min_version).toBe("140.0")
      expect(firefox.browser_specific_settings.gecko_android.strict_min_version).toBe("142.0")
      expect(firefox.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(["websiteContent", "browsingActivity"])
      expect(firefox.browser_specific_settings.gecko.data_collection_permissions.required).not.toContain("none")
      const background = readFileSync(join(out, "unpacked", "chrome-edge", "background.js"), "utf8")
      expect(background).toContain('await send("Input.insertText", { text })')
      expect(background).toContain("const READ_FIELD = (ref) => {")
      expect(background).toContain('if (autofilled) return "autofilled"')
    } finally { rmSync(out, { recursive: true, force: true }) }
  }, 60_000)

  test("the privacy note says what reaches the local app, matching the Firefox declaration", () => {
    const privacy = readFileSync(join(ROOT, "PRIVACY.md"), "utf8")
    expect(privacy).toContain("websiteContent")
    expect(privacy).toContain("browsingActivity")
  })
})
