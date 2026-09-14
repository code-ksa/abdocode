import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { brokenAliasViolation, killByNameViolation } from "../src/shell-command-guard"
import { systemTool } from "../src/system-tools"

describe("kill-by-name guard — catalog 1.3", () => {
  // الحادثتان الحيتان: Stop-Process -Name وGet-Process | Stop-Process.
  test("refuses every kill-by-name shape the model actually used", () => {
    expect(killByNameViolation("powershell -Command \"Get-Process -Name node | Stop-Process -Force\"")).toContain("قتلها قرارها")
    expect(killByNameViolation("Stop-Process -Name node -Force")).toBeDefined()
    expect(killByNameViolation("taskkill /IM node.exe /F")).toBeDefined()
    expect(killByNameViolation("pkill node")).toBeDefined()
  })

  test("allows measured single-pid stops and unrelated commands", () => {
    expect(killByNameViolation("Stop-Process -Id 1234 -Force")).toBeUndefined()
    expect(killByNameViolation("taskkill /PID 1234 /T /F")).toBeUndefined()
    expect(killByNameViolation("Get-Process -Name node")).toBeUndefined()
    expect(killByNameViolation("npm run build")).toBeUndefined()
  })
})

describe("broken alias guard — catalog 6.1", () => {
  test("refuses curl and wget aliases with a named redirect", () => {
    expect(brokenAliasViolation("curl -s http://localhost:3000/api/services")).toContain("Invoke-WebRequest")
    expect(brokenAliasViolation("curl http://localhost:3000/")).toContain("KF-2")
    expect(brokenAliasViolation("wget http://example.com/file.zip")).toContain("OutFile")
  })

  test("allows explicit curl.exe and unrelated commands", () => {
    expect(brokenAliasViolation("C:\\Windows\\System32\\curl.exe -s http://x/")).toBeUndefined()
    expect(brokenAliasViolation("Invoke-WebRequest -UseBasicParsing -Uri http://x/")).toBeUndefined()
    expect(brokenAliasViolation("npm install curling-league")).toBeUndefined()
  })
})

describe("system tools — catalog 6.3", () => {
  test("resolves known tools to absolute existing paths", () => {
    for (const name of ["taskkill", "netstat", "cmd", "tasklist"] as const) {
      const path = systemTool(name)
      expect(path).toMatch(/^[A-Za-z]:[\\/]/)
      expect(existsSync(path)).toBe(true)
    }
  })
})
