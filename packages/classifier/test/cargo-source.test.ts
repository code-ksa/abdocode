/**
 * CL-11.5A — Cargo classification, from the command alone.
 *
 * Written BEFORE any Cargo measurement, deliberately: every behavioural claim
 * is `unknown` here and gets settled in the measurement half. The one structural
 * fact this layer DOES assert is the one that makes Cargo different from pip,
 * Poetry and Pipenv — compiling IS executing, because `build.rs` runs as a
 * native program and proc-macro crates run inside the compiler. No flag turns
 * that off, so it is unconditional rather than a maybe.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessCargo } from "../src/index"

const A = (cmd: string) => assessCargo(normalize(cmd, {}).commands ?? [])

describe("CL-11.5A what is a cargo command", () => {
  test("the common verbs are recognised", () => {
    for (const [cmd, verb] of [
      ["cargo build", "build"], ["cargo test", "test"], ["cargo run", "run"],
      ["cargo update", "update"], ["cargo fetch", "fetch"], ["cargo install ripgrep", "install"],
    ] as const) {
      expect(A(cmd).verb).toBe(verb)
      expect(A(cmd).isCargo).toBe(true)
    }
  })

  test("`rustup run <toolchain> cargo …` reaches the same place", () => {
    const a = A("rustup run nightly cargo build")
    expect(a.isCargo).toBe(true)
    expect(a.verb).toBe("build")
    expect(a.compiles).toBe(true)
  })

  test("a `+toolchain` override is surfaced, not ignored", () => {
    const a = A("cargo +nightly build")
    expect(a.verb).toBe("build")
    expect(a.blockers).toContain("cargo_toolchain_override:nightly")
  })

  test("non-cargo commands are not claimed", () => {
    for (const cmd of ["npm ci", "poetry install", "pipenv sync", "ls"]) {
      expect(A(cmd).isCargo).toBe(false)
    }
  })

  test("an unmodelled verb is flagged rather than assumed harmless", () => {
    expect(A("cargo frobnicate").blockers).toContain("cargo_verb_unmodelled:frobnicate")
  })
})

describe("CL-11.5A compiling IS executing", () => {
  test("every compiling verb carries build-script AND proc-macro execution", () => {
    for (const cmd of ["cargo build", "cargo check", "cargo test", "cargo doc", "cargo clippy"]) {
      const a = A(cmd)
      expect(a.compiles).toBe(true)
      expect(a.blockers).toContain("cargo_build_scripts_may_execute")
      expect(a.blockers).toContain("cargo_proc_macros_may_execute")
    }
  })

  test("no flag removes it — not --locked, --offline or --frozen", () => {
    const a = A("cargo build --locked --offline --frozen")
    expect(a.blockers).toContain("cargo_build_scripts_may_execute")
    expect(a.blockers).toContain("cargo_proc_macros_may_execute")
  })

  test("run / test / bench / install additionally execute built binaries", () => {
    for (const cmd of ["cargo run", "cargo test", "cargo bench", "cargo install ripgrep"]) {
      expect(A(cmd).executes).toBe(true)
      expect(A(cmd).blockers).toContain("cargo_executes_built_binaries")
    }
    expect(A("cargo check").executes).toBe(false)
  })

  test("`cargo install` writes outside the workspace", () => {
    expect(A("cargo install ripgrep").blockers).toContain("cargo_install_writes_outside_workspace")
  })

  test("the toolchain config that names programs to run is never on the command line", () => {
    // .cargo/config.toml, RUSTC_WRAPPER, RUSTFLAGS, linker and runner settings.
    expect(A("cargo build").blockers).toContain("cargo_toolchain_config_unresolved")
  })
})

describe("CL-11.5A lock and network flags are CLAIMS until measured", () => {
  test("--locked / --offline / --frozen are recorded but not believed", () => {
    const a = A("cargo build --frozen")
    expect(a.frozen).toBe(true)
    expect(a.locked).toBe(true)      // --frozen documents itself as both
    expect(a.offline).toBe(true)
    expect(a.lockImmutabilityEnforced).toBe("unknown")
    expect(a.networkPrevented).toBe("unknown")
  })

  test("without them, lock drift and network are open questions flagged as such", () => {
    const a = A("cargo build")
    expect(a.blockers).toContain("cargo_lock_may_change")
    expect(a.blockers).toContain("cargo_network_allowed")
    const b = A("cargo build --locked --offline")
    expect(b.blockers).not.toContain("cargo_lock_may_change")
    expect(b.blockers).not.toContain("cargo_network_allowed")
  })

  test("resolving verbs rewrite the lock", () => {
    for (const cmd of ["cargo update", "cargo add serde", "cargo generate-lockfile"]) {
      expect(A(cmd).resolvesDependencies).toBe(true)
      expect(A(cmd).blockers).toContain("cargo_resolves_and_rewrites_lock")
    }
    expect(A("cargo build").resolvesDependencies).toBe(false)
  })
})

describe("CL-11.5A outward operations and options", () => {
  test("publish and friends are outward", () => {
    for (const cmd of ["cargo publish", "cargo yank --vers 1.0.0 mycrate"]) {
      expect(A(cmd).outward).toBe(true)
      expect(A(cmd).blockers.some((b) => b.startsWith("cargo_outward_operation:"))).toBe(true)
    }
  })

  test("--target-dir and feature widening are captured", () => {
    expect(A("cargo build --target-dir /tmp/out").targetDir).toBe("/tmp/out")
    expect(A("cargo build --target-dir=/tmp/out").targetDir).toBe("/tmp/out")
    expect(A("cargo build --all-features").widensFeatures).toBe(true)
    expect(A("cargo build --features foo").widensFeatures).toBe(true)
    expect(A("cargo build").widensFeatures).toBe(false)
  })
})

describe("CL-11.5A nothing here can auto-allow", () => {
  test("even the tightest shape carries the not-implemented blocker", () => {
    const a = A("cargo build --frozen")
    expect(a.blockers).toContain("cargo_verifier_not_implemented")
    expect(a.blockers.length).toBeGreaterThan(0)
  })

  test("a compound command is judged worst-wins", () => {
    const a = A("cargo build --frozen && cargo update")
    expect(a.resolvesDependencies).toBe(true)
    expect(a.blockers).toContain("cargo_resolves_and_rewrites_lock")
    expect(a.locked).toBe(false)  // `update` had no --locked, so not every member did
  })
})
