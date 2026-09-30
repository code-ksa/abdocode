/**
 * 09-30 — مقيس على مهمّة OpenRouter (المثبَّت 4.0.98): `npm install … && npx tailwindcss init -p` رُفض مرّتين «&& غير مدعوم في PowerShell 5.1».
 * الآن تُترجم سلسلةُ && الخالصة و|| الواحدة حتميّاً؛ والتوأمُ يشغّل المترجَمَ في PowerShell 5.1 الحقيقيّ ليثبت الدلالة لا النصّ.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { powershellChainRepair } from "../src/powershell-call-repair"

describe("&& / || chains become PowerShell 5.1", () => {
  test("the measured command is translated, in order, stopping at a failure", () => {
    const r = powershellChainRepair("npm install -D tailwindcss postcss autoprefixer && npx tailwindcss init -p")
    expect(r?.command).toBe("npm install -D tailwindcss postcss autoprefixer; if ($?) { npx tailwindcss init -p }")
    expect(r?.note).toContain("«&&»")
    expect(powershellChainRepair("a && b && c")?.command).toBe("a; if ($?) { b; if ($?) { c } }")
    expect(powershellChainRepair("npm test || echo failed")?.command).toBe("npm test; if (-not $?) { echo failed }")
  })

  test("the twins: quotes, mixed operators, remote shells and empty parts are left alone", () => {
    expect(powershellChainRepair('git commit -m "a && b"')).toBeUndefined()
    expect(powershellChainRepair("a && b || c")).toBeUndefined()
    expect(powershellChainRepair("a || b || c")).toBeUndefined()
    expect(powershellChainRepair("ssh host 'cd /x && ls'")).toBeUndefined()
    expect(powershellChainRepair("wsl bash -c 'a && b'")).toBeUndefined()
    expect(powershellChainRepair("a && ")).toBeUndefined()
    expect(powershellChainRepair("npm run build")).toBeUndefined()
    expect(powershellChainRepair('echo "unclosed && x')).toBeUndefined()
  })

  test.skipIf(process.platform !== "win32")("the translation runs with the right meaning in real PowerShell 5.1", () => {
    const ps = (script: string) => {
      const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" })
      return new TextDecoder().decode(r.stdout).replace(/\r/gu, "").trim().split("\n").filter((l) => l.length > 0)
    }
    expect(ps(powershellChainRepair("cmd /c echo one && cmd /c echo two")!.command)).toEqual(["one", "two"])
    expect(ps(powershellChainRepair("cmd /c exit 1 && cmd /c echo never")!.command)).toEqual([])
    expect(ps(powershellChainRepair("cmd /c exit 1 || cmd /c echo fallback")!.command)).toEqual(["fallback"])
    expect(ps(powershellChainRepair("cmd /c echo ok || cmd /c echo never")!.command)).toEqual(["ok"])
  })

  test("the engine repairs before its shell guard would refuse", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    const repair = cli.indexOf("const chainRepair = powershellChainRepair(cmd)")
    const guard = cli.indexOf("const dangerous = violationAcrossVariants(cmd, dangerousShellViolation)")
    expect(repair).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(repair)
  })
})
