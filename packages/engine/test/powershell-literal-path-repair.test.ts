/**
 * 10-01 — مقيس على مهمّة OpenRouter: `Remove-Item -Recurse -Force src/app/api/models/[id]` لم يفعل شيئاً (نمطُ بدل) فضاع نداءان.
 * التوأمُ يشغّل الخامَ والمُصلَحَ في PowerShell 5.1 الحقيقيّ على مجلّدٍ اسمُه [id].
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { powershellLiteralPathRepair } from "../src/powershell-call-repair"

describe("PowerShell paths with [ ] use -LiteralPath", () => {
  test("the measured commands are repaired", () => {
    expect(powershellLiteralPathRepair("Remove-Item -Recurse -Force src/app/api/models/[id]")?.command).toBe("Remove-Item -Recurse -Force -LiteralPath 'src/app/api/models/[id]'")
    expect(powershellLiteralPathRepair("Remove-Item -Path 'src/app/api/models/[...id]' -Recurse -Force")?.command).toBe("Remove-Item -LiteralPath 'src/app/api/models/[...id]' -Recurse -Force")
    expect(powershellLiteralPathRepair("Test-Path src/app/models/[provider]/[model]/page.tsx")?.command).toBe("Test-Path -LiteralPath 'src/app/models/[provider]/[model]/page.tsx'")
    expect(powershellLiteralPathRepair("Get-ChildItem -Filter *.tsx src/app/[slug]")?.command).toBe("Get-ChildItem -Filter *.tsx -LiteralPath 'src/app/[slug]'")
    expect(powershellLiteralPathRepair("Remove-Item -Recurse -Force src/app/api/models/[id]")?.note).toContain("-LiteralPath")
  })

  test("the twins: already literal, real wildcards, chains, other commands and bracket-free paths are left alone", () => {
    expect(powershellLiteralPathRepair("Remove-Item -LiteralPath 'src/app/api/models/[id]' -Recurse -Force")).toBeUndefined()
    expect(powershellLiteralPathRepair("Remove-Item src/app/[id]/*.bak")).toBeUndefined()
    expect(powershellLiteralPathRepair("Get-ChildItem src/app/[a-c]?")).toBeUndefined()
    expect(powershellLiteralPathRepair("Remove-Item src/app/[id]; npm run build")).toBeUndefined()
    expect(powershellLiteralPathRepair("npm run build -- src/app/[id]")).toBeUndefined()
    expect(powershellLiteralPathRepair("Remove-Item -Recurse -Force .next")).toBeUndefined()
  })

  test.skipIf(process.platform !== "win32")("in real PowerShell 5.1: the raw command silently keeps [id], the repaired one removes it", () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-literal-"))
    try {
      const dir = join(root, "[id]")
      mkdirSync(dir)
      writeFileSync(join(dir, "route.ts"), "export {}")
      const ps = (script: string) => Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { cwd: root, stdout: "pipe", stderr: "pipe" })
      ps("Remove-Item -Recurse -Force [id]")
      expect(existsSync(dir)).toBe(true)
      ps(powershellLiteralPathRepair("Remove-Item -Recurse -Force [id]")!.command)
      expect(existsSync(dir)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("the engine repairs before its shell guards", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    const repair = cli.indexOf("const literalRepair = powershellLiteralPathRepair(cmd)")
    const guard = cli.indexOf("const dangerous = violationAcrossVariants(cmd, dangerousShellViolation)")
    expect(repair).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(repair)
    expect(cli.slice(repair, repair + 300)).toContain("cmd = literalRepair.command")
  })
})
