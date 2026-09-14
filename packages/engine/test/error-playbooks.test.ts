import { describe, expect, test } from "bun:test"
import { errorPlaybookHints, PLAYBOOKS } from "../src/error-playbooks"

describe("error playbooks — S6 registry", () => {
  const cases: [string, string][] = [
    ["password authentication failed for user \"admin\"", "pg-password"],
    ["Error: database is locked", "sqlite-locked"],
    ["No flag registered for --datasource-provider", "--help"],
    ['{"kind":"result","envelope":{"ok":false,"commandId":"init","error":{"code":"CLI.INVALID_ARGUMENTS","summary":"No flag registered for --datasource-provider"}}}', "orm init"],
    ["gyp ERR! build error\nMSBuild.exe failed", "node-gyp"],
    ["npm ci can only install with an up to date package-lock", "lock"],
    ["npm ERR! ERESOLVE unable to resolve dependency tree", "peer"],
    ["Error: ENAMETOOLONG: name too long", "طول المسار"],
    ["Unexpected token ﻿ in JSON at position 0", "BOM"],
    ["File is being used by another process (EBUSY)", "مقفول"],
    ["HTTP 429 Too Many Requests", "المعدّل"],
    ["getaddrinfo ENOTFOUND api.example.com", "DNS"],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432", "رُفض"],
    ["Error: CERT_HAS_EXPIRED", "الشهادة"],
    ["ENOSPC: no space left on device", "القرص"],
    ["Error: EMFILE: too many open files", "مقابض"],
    ["FATAL ERROR: JavaScript heap out of memory", "V8"],
    ["CUDA out of memory. Tried to allocate", "GPU"],
    ["Warning: Text content does not match server-rendered HTML (hydration)", "الترطيب"],
    ["Error [ERR_REQUIRE_ESM]: require() of ES Module", "ESM"],
    ["auth.test.ts(30,18): error TS2353: 'Content-Type' does not exist in type 'Headers'", "Request"],
    ["route.ts(26,50): error TS2304: Cannot find name 'ADMIN_PASSWORD_HASH'.", "بلا تعريف"],
    ["Error: Failed to resolve /src/main.tsx from C:/x/index.html", "createRoot"],
    ["error[E0432]: unresolved import — use of undeclared crate or module `serde`", "Cargo.toml"],
    ["error[E0382]: borrow of moved value: `tasks`", "ملكية"],
    ["go: cannot find main module; see 'go help modules'", "go mod init"],
    ["./main.go:7:2: imported and not used: \"fmt\"", "غير المستعملة"],
    ["main.obj : error LNK2019: unresolved external symbol", "بلا تعريف"],
    ["'cl' is not recognized as an internal or external command", "vcvars"],
    ["fatal error C1083: Cannot open include file: 'lib.h'", "الترويسات"],
    ["page.tsx(4,10): error TS2305: Module './auth' has no exported member 'verifyToken'", "لا تصدّره"],
    ["running scripts is disabled on this system (ExecutionPolicy)", "PowerShell"],
    ["The requested operation requires elevation", "مسؤول"],
  ]

  for (const [output, needle] of cases) {
    test(`diagnoses: ${needle}`, () => {
      const hint = errorPlaybookHints(output)
      expect(hint.length).toBeGreaterThan(0)
      expect(hint).toContain(needle)
    })
  }

  test("stays silent on clean output and caps the count", () => {
    expect(errorPlaybookHints("✓ Compiled successfully")).toBe("")
    const many = "ENOSPC EMFILE ECONNREFUSED ENOTFOUND 429 database is locked"
    expect(errorPlaybookHints(many).split("\n").filter((l) => l.startsWith("«")).length).toBeLessThanOrEqual(3)
  })

  test("every playbook has a unique id and a non-trivial hint", () => {
    const ids = new Set(PLAYBOOKS.map((p) => p.id))
    expect(ids.size).toBe(PLAYBOOKS.length)
    for (const p of PLAYBOOKS) expect(p.hint.length).toBeGreaterThan(30)
  })

  test("TLS disable attempt is flagged as its own class", () => {
    expect(errorPlaybookHints("set NODE_TLS_REJECT_UNAUTHORIZED=0")).toContain("رُفض تعطيل")
  })
})
