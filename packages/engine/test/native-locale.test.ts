import { describe, expect, test } from "bun:test"
import { PLUGINS } from "../src/plugin-registry"
import { translateUI } from "../../desktop/ui/native-locale.js"

describe("native shell locale dictionary", () => {
  test("has English labels and descriptions for the real plugin registry", () => {
    for (const plugin of PLUGINS) {
      const label = translateUI(plugin.label, "en")
      const description = translateUI(plugin.description, "en")
      expect(label).not.toMatch(/[\u0600-\u06ff]/)
      expect(description).not.toMatch(/[\u0600-\u06ff]/)
      expect(translateUI(label, "ar")).toBe(plugin.label)
      expect(description.length).toBeGreaterThan(25)
    }
  })

  test("unknown text and command/URL substrings are left byte-identical", () => {
    for (const text of [
      "C:/Users/Settings/محادثة جديدة.txt",
      "https://example.com/Settings?q=الإعدادات",
      "run echo 'حفظ'",
      "A user wrote: Settings",
      "deepseek/deepseek-v4-flash",
      "",
      "  \n\t",
    ]) {
      expect(translateUI(text, "en")).toBe(text)
      expect(translateUI(text, "ar")).toBe(text)
    }
  })

  test("preserves whitespace and renders the product brand", () => {
    expect(translateUI(" \nالإعدادات\t ", "en")).toBe(" \nSettings\t ")
    expect(translateUI("ABDO CODE / RUST", "en")).toBe("AbdoCode")
    expect(translateUI("عبدو كود", "en")).toBe("AbdoCode")
    expect(translateUI("AbdoCode", "ar")).toBe("عبدو كود")
  })

  test("preserves operational limits in security-related plugin help", () => {
    const help = (name: string) => translateUI(PLUGINS.find(p => p.name === name)!.description, "en")
    expect(help("reviewer")).toContain("cannot edit")
    expect(help("unattendedDeny")).toContain("silence never grants permission")
    expect(help("standingGrants")).toContain("this session only")
    expect(help("inboundGuard")).toContain("preserve ordinary content")
    expect(help("mcpClient")).toContain("approval gate")
  })
})
