import { describe, expect, test } from "bun:test"
import { bracketDeleteNote, bracketDeletePath } from "../src/powershell-bracket-guard"

// 09-29 — مقيس على مهمّة OpenRouter: «Remove-Item -Recurse -Force 'src/app/models/[id]' -ErrorAction SilentlyContinue» خرج 0 ولم يحذف.
describe("PowerShell bracket delete trap", () => {
  test("names the bracketed path of a delete command, quoted or bare, unless -LiteralPath is used", () => {
    expect(bracketDeletePath("run powershell -Command \"Remove-Item -Recurse -Force 'src/app/models/[id]' -ErrorAction SilentlyContinue\"")).toBe("src/app/models/[id]")
    expect(bracketDeletePath('Remove-Item -Recurse -Force "C:\\proj\\app\\[slug]"')).toBe("C:\\proj\\app\\[slug]")
    expect(bracketDeletePath("rm -r src/app/[id]")).toBe("src/app/[id]")
    expect(bracketDeletePath("Remove-Item -LiteralPath 'src/app/models/[id]' -Recurse -Force")).toBeUndefined()
    expect(bracketDeletePath("Remove-Item -Recurse -Force .next")).toBeUndefined()
    expect(bracketDeletePath("Get-ChildItem 'src/app/models/[id]'")).toBeUndefined()
  })

  test("the note appears only when the bracketed path still exists after the command, and names -LiteralPath", () => {
    const cmd = "powershell -Command \"Remove-Item -Recurse -Force 'src/app/models/[id]' -ErrorAction SilentlyContinue\""
    const note = bracketDeleteNote(cmd, "C:\\proj", (p) => p === "C:\\proj/src/app/models/[id]")
    expect(note).toContain("ما زال موجوداً")
    expect(note).toContain("Remove-Item -LiteralPath 'src/app/models/[id]' -Recurse -Force")
    expect(bracketDeleteNote(cmd, "C:\\proj", () => false)).toBe("")
    expect(bracketDeleteNote("Remove-Item -Recurse -Force .next", "C:\\proj", () => true)).toBe("")
    // absolute paths are checked as given
    expect(bracketDeleteNote("Remove-Item -Recurse -Force 'C:\\p\\[x]'", "C:\\proj", (p) => p === "C:\\p\\[x]")).toContain("-LiteralPath")
  })
})
