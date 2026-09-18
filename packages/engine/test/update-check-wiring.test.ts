import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const shell = readFileSync(join(import.meta.dir, "..", "..", "desktop", "ui", "native-shell.js"), "utf8")
const rust = readFileSync(join(import.meta.dir, "..", "..", "desktop", "src-tauri", "src", "release_check.rs"), "utf8")

describe("update notifications — wiring", () => {
  test("the shell re-checks every six hours and on focus after an hour, honours the opt-out, and shows a primary Update button with the release page", () => {
    expect(shell).toContain("const UPDATE_RECHECK_MS=6*60*60*1000,UPDATE_FOCUS_MIN_MS=60*60*1000")
    expect(shell).toContain("setTimeout(scheduledUpdateCheck,8000);setInterval(scheduledUpdateCheck,UPDATE_RECHECK_MS);")
    expect(shell).toContain("window.addEventListener('focus',()=>{if(lastUpdateCheck>0&&Date.now()-lastUpdateCheck>UPDATE_FOCUS_MIN_MS)scheduledUpdateCheck();});")
    expect(shell).toContain("if(bridge.snapshot?.()?.settings?.updateCheckEnabled===false)return;")
    // الإصدارُ المرفوض لا يُعاد عرضُه؛ الأحدثُ منه يُعرض — والزرُّ يفتح صفحةَ الإصدار بيد المستخدم (لا تنزيلَ آليّ).
    expect(shell).toContain("if(manual||updateDismissed!==release.latest){showUpdateAvailable(release)")
    expect(shell).toContain("bridge.invoke('open_external',{url:info.page})")
  })
  test("the feed is read from the public distribution repo only and foreign pages fall back", () => {
    expect(rust).toContain('pub(crate) const FEED_URL: &str = "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/abdocode-desktop.json";')
    expect(rust).toContain('const PAGE_PREFIX: &str = "https://github.com/code-ksa/";')
  })
})
