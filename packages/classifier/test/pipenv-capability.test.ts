/**
 * CL-16A §0 — Pipenv is classified EXPLICITLY, not by fallback.
 *
 * Until now Pipenv reached `ask`, but only because an unlisted program falls to
 * `unknown` capability and the conservative risk floor catches it. That is the
 * right OUTCOME for the wrong REASON: a fallback is not a policy, it hides which
 * verb was actually requested (`pipenv install` and `pipenv run` are very
 * different acts), and anything that later narrows the floor would silently open
 * it.
 *
 * These tests pin both halves: the capability is named, and the outcome is still
 * Ask.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { classifyAll } from "../src/index"

const capsOf = (cmd: string) => classifyAll(normalize(cmd, {}).commands ?? [])

describe("CL-16A pipenv has an explicit capability, not `unknown`", () => {
  test("install / sync are package.install", () => {
    for (const cmd of ["pipenv install", "pipenv sync", "pipenv install --deploy", "pipenv sync --system"]) {
      const { capabilities, anyUnknown } = capsOf(cmd)
      expect(capabilities).toContain("package.install")
      expect(anyUnknown).toBe(false)   // no longer riding the fallback
    }
  })

  test("lock / update are package.update", () => {
    for (const cmd of ["pipenv lock", "pipenv update"]) {
      expect(capsOf(cmd).capabilities).toContain("package.update")
    }
  })

  test("run / shell are package.script — arbitrary execution, not an install", () => {
    for (const cmd of ["pipenv run python evil.py", "pipenv shell"]) {
      expect(capsOf(cmd).capabilities).toContain("package.script")
    }
  })

  test("a path-invoked pipenv is classified the same", () => {
    expect(capsOf("./tools/pipenv install").capabilities).toContain("package.install")
    expect(capsOf("/usr/local/bin/pipenv sync").capabilities).toContain("package.install")
  })

  test("the classification did not weaken poetry or pip alongside it", () => {
    expect(capsOf("poetry install").capabilities).toContain("package.install")
    expect(capsOf("pip install x").capabilities).toContain("package.install")
    expect(capsOf("npm ci").capabilities).toContain("package.install")
  })
})
