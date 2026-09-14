import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localCopyInTestViolation } from "../src/closure-gate"

describe("local-copy-in-test guard — the always-green fake (caught twice on 2026-08-31)", () => {
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lc-"))
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "Muealij.kt"), "object Muealij { fun tatbie(s: String): String = s }")
    writeFileSync(join(dir, "src", "logic.py"), "def compute(x):\n    return x * 2\n")
    return dir
  }

  test("a Kotlin test redeclaring the source object is refused by name", () => {
    const dir = project()
    try {
      const v = localCopyInTestViolation("src/Test.kt", "object Muealij { fun tatbie(s: String): String = s }\nfun main() {}", dir)
      expect(v).toContain("Muealij")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a Python test redefining a source function is refused", () => {
    const dir = project()
    try {
      const v = localCopyInTestViolation("test_db.py", "def compute(x):\n    return x * 2\n", dir)
      expect(v).toContain("compute")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a test that only calls the real unit passes", () => {
    const dir = project()
    try {
      expect(localCopyInTestViolation("src/Test.kt", "fun main() { println(Muealij.tatbie(\"x\")) }", dir)).toBeUndefined()
      expect(localCopyInTestViolation("test_db.py", "import logic\nassert logic.compute(2) == 4\n", dir)).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("non-test files and js tests are out of scope here", () => {
    const dir = project()
    try {
      expect(localCopyInTestViolation("src/Muealij.kt", "object Muealij {}", dir)).toBeUndefined()
      expect(localCopyInTestViolation("app.test.ts", "const x = 1", dir)).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
