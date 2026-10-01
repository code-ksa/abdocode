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

// 2026-09-28 — `.next` فسد تحت خادم dev حيّ بعد `next build` على المجلد نفسه.
test("diagnoses a stale .next under a live dev server and names stop <pid>", () => {
  const output = "Error: Cannot find module './787.js'\nRequire stack:\n- C:\\Users\\x\\Desktop\\app\\.next\\server\\webpack-runtime.js\n- C:\\Users\\x\\Desktop\\app\\.next\\server\\app\\api\\models\\route.js"
  const hint = errorPlaybookHints(output)
  expect(hint).toContain("next-stale-build-under-dev")
  expect(hint).toContain("stop <pid>")
  expect(errorPlaybookHints("Cannot find module 'lodash'")).not.toContain("next-stale-build-under-dev")
})

// 10-01 — مقيس: «Cannot apply unknown utility class» في مشروع Tailwind 4 فأنزل النموذجُ الإصدارَ إلى 3.4 بدل إصلاح النمط.
describe("tailwind 4 with v3 syntax", () => {
  const measured = "Error: Cannot apply unknown utility class `border-border`. Are you using CSS modules or similar and missing `@reference`?\nFailed to compile.\n./src/app/globals.css:1:1\n> 1 | @tailwind base;"
  test("the measured failure is told to keep v4 and fix the syntax: @import, @theme tokens, the v4 postcss plugin", () => {
    const hint = errorPlaybookHints(measured)
    expect(hint).toContain("«tailwind4-v3-syntax»")
    expect(hint).toContain("لا تُنزل Tailwind إلى 3")
    expect(hint).toContain('@import \"tailwindcss\";')
    expect(hint).toContain("@theme { --color-border")
    // مقيس: «Cannot apply unknown utility class `btn-base`» — صنفٌ مخصّص في @apply يحتاج @utility في الإصدار 4.
    expect(hint).toContain("@utility btn-base { … }")
  })
  test("Tailwind 3's own message for a missing class, and a clean build, get no such hint", () => {
    expect(errorPlaybookHints("The `border-border` class does not exist. If `border-border` is a custom class, make sure it is defined within a `@layer` directive.")).not.toContain("tailwind4-v3-syntax")
    expect(errorPlaybookHints("> next build\n✓ Compiled successfully")).not.toContain("tailwind4-v3-syntax")
  })
})

// 10-01 — مقيس في Sprint 14: أربعةُ بناءاتٍ متتالية لاكتشاف outline ثمّ default ثمّ destructive ثمّ link.
describe("next build stops at the first type error", () => {
  const measured = "> next build\n▲ Next.js 14.2.26\n✓ Compiled successfully\nLinting and checking validity of types ...\nFailed to compile.\n\n./src/app/account/activity/page.tsx:97:27\nType error: Type '\"outline\"' is not assignable to type '\"primary\" | \"secondary\" | \"ghost\" | \"danger\" | undefined'.\nNext.js build worker exited with code: 1 and signal: null\nانتهى الأمر برمز 1"
  test("the measured failure gets the all-errors-at-once command and the look-before-changing-props rule", () => {
    const hint = errorPlaybookHints(measured)
    expect(hint).toContain("«next-build-first-type-error»")
    expect(hint).toContain("run npx tsc --noEmit --incremental false -p .")
    expect(hint).toContain("grep -rn")
  })
  test("a successful build, or a failure that is not a type error, gets no such hint", () => {
    expect(errorPlaybookHints("> next build\n✓ Compiled successfully\nRoute (app)")).not.toContain("next-build-first-type-error")
    expect(errorPlaybookHints("Failed to compile.\nModule not found: Can't resolve '@/lib/x'")).not.toContain("next-build-first-type-error")
    expect(errorPlaybookHints("src/a.ts(3,1): error TS2322: Type 'x' is not assignable")).not.toContain("next-build-first-type-error")
  })
})

