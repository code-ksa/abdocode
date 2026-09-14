/**
 * CL-11.6A — Go classification, from the command alone.
 *
 * Written before any Go measurement. Go is the first manager where a
 * genuinely read-only path looks plausible — `go mod verify`, `go list`,
 * `go mod download` may touch no project code — so this layer is careful to
 * RECORD that shape without asserting it. Whether those commands really run
 * nothing is measured in the second half; here they simply are not marked as
 * compiling or executing.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessGo } from "../src/index"

const A = (cmd: string) => assessGo(normalize(cmd, {}).commands ?? [])

describe("CL-11.6A verbs, including the two-word ones", () => {
  test("single-word verbs", () => {
    for (const [cmd, verb] of [["go build", "build"], ["go test ./...", "test"], ["go run main.go", "run"], ["go vet ./...", "vet"]] as const) {
      expect(A(cmd).verb).toBe(verb)
      expect(A(cmd).isGo).toBe(true)
    }
  })

  test("`go mod <sub>` and `go work <sub>` keep both words", () => {
    expect(A("go mod download").verb).toBe("mod download")
    expect(A("go mod tidy").verb).toBe("mod tidy")
    expect(A("go mod verify").verb).toBe("mod verify")
    expect(A("go work sync").verb).toBe("work sync")
  })

  test("`go tool <name>` runs a toolchain program directly", () => {
    expect(A("go tool compile x.go").blockers).toContain("go_tool_direct_invocation:compile")
  })

  test("non-go commands are not claimed", () => {
    for (const cmd of ["cargo build", "npm ci", "poetry install", "ls"]) {
      expect(A(cmd).isGo).toBe(false)
    }
  })
})

describe("CL-11.6A which verbs compile, execute, or mutate", () => {
  test("compiling verbs are marked", () => {
    for (const cmd of ["go build", "go test ./...", "go run .", "go install ./cmd/x", "go vet ./..."]) {
      expect(A(cmd).compiles).toBe(true)
      expect(A(cmd).blockers).toContain("go_compiles_code")
    }
  })

  test("read-shaped verbs are NOT marked as compiling (a claim to be measured)", () => {
    for (const cmd of ["go mod verify", "go list ./...", "go mod download", "go env"]) {
      const a = A(cmd)
      expect(a.compiles).toBe(false)
      expect(a.executesProjectCode).toBe(false)
    }
  })

  test("test / run / generate execute PROJECT code", () => {
    for (const cmd of ["go test ./...", "go run .", "go generate ./..."]) {
      expect(A(cmd).executesProjectCode).toBe(true)
      expect(A(cmd).blockers).toContain("go_executes_project_code")
    }
    expect(A("go generate ./...").blockers).toContain("go_generate_runs_directives")
    expect(A("go build").executesProjectCode).toBe(false)
  })

  test("get / tidy / vendor mutate module files; install writes GOBIN", () => {
    for (const cmd of ["go get example.com/x", "go mod tidy", "go mod vendor"]) {
      expect(A(cmd).mutatesModuleFiles).toBe(true)
      expect(A(cmd).blockers).toContain("go_mutates_module_files")
    }
    expect(A("go install ./cmd/x").blockers).toContain("go_install_writes_gobin")
  })
})

describe("CL-11.6A durable global side effects", () => {
  test("`go env -w` is a PERSISTENT machine-wide change, not a query", () => {
    const a = A("go env -w GOPROXY=off")
    expect(a.mutatesGlobalState).toBe(true)
    expect(a.blockers).toContain("go_mutates_global_state")
    // ...while a plain query is not.
    expect(A("go env").mutatesGlobalState).toBe(false)
  })

  test("`go clean -modcache` destroys a machine-shared cache", () => {
    expect(A("go clean -modcache").mutatesGlobalState).toBe(true)
    expect(A("go clean").mutatesGlobalState).toBe(false)
  })
})

describe("CL-11.6A flags that name programs or rewrite sources", () => {
  test("-toolexec and -exec name programs the toolchain runs", () => {
    expect(A("go build -toolexec=/tmp/w ./...").blockers).toContain("go_exec_flag:toolexec")
    expect(A("go test -exec=/tmp/w ./...").blockers).toContain("go_exec_flag:exec")
    expect(A("go build -toolexec=/tmp/w ./...").executionFlags).toContain("-toolexec")
  })

  test("-overlay rewrites what the toolchain sees without touching the disk", () => {
    expect(A("go build -overlay=o.json ./...").blockers).toContain("go_overlay_rewrites_sources")
  })

  test("-modfile and -buildmode are surfaced", () => {
    expect(A("go build -modfile=alt.mod ./...").blockers).toContain("go_alternate_modfile")
    expect(A("go build -buildmode=plugin ./...").blockers).toContain("go_buildmode_set")
  })

  test("-mod= is recorded; only `mod` is called out as writable", () => {
    expect(A("go build -mod=readonly ./...").modMode).toBe("readonly")
    expect(A("go build -mod=vendor ./...").modMode).toBe("vendor")
    expect(A("go build -mod=mod ./...").blockers).toContain("go_mod_mode_writable")
    expect(A("go build -mod=readonly ./...").blockers).not.toContain("go_mod_mode_writable")
  })

  test("-o output path is captured", () => {
    expect(A("go build -o /tmp/out ./...").outputPath).toBe("/tmp/out")
    expect(A("go build -o=/tmp/out ./...").outputPath).toBe("/tmp/out")
  })
})

describe("CL-11.6A the environment is most of the story, and it is not in argv", () => {
  test("every go command flags the unresolved environment surface", () => {
    // GOFLAGS, GOPROXY, GOSUMDB, GOPRIVATE, GOINSECURE, GOTOOLCHAIN, CC, CXX,
    // CGO_ENABLED, GOWORK — none appear on the command line.
    for (const cmd of ["go build", "go list ./...", "go mod verify"]) {
      expect(A(cmd).blockers).toContain("go_environment_surface_unresolved")
    }
  })

  test("toolchain selection is unresolved — GOTOOLCHAIN can fetch another Go", () => {
    expect(A("go build").blockers).toContain("go_toolchain_selection_unresolved")
    expect(A("go mod download").blockers).toContain("go_toolchain_selection_unresolved")
  })

  test("lock and network enforcement stay unknown until measured", () => {
    const a = A("go build -mod=readonly ./...")
    expect(a.moduleImmutabilityEnforced).toBe("unknown")
    expect(a.networkPrevented).toBe("unknown")
  })
})

describe("CL-11.6A nothing here can auto-allow", () => {
  test("even `go mod verify` carries the not-implemented blocker", () => {
    expect(A("go mod verify").blockers).toContain("go_verifier_not_implemented")
  })

  test("a compound command is judged worst-wins", () => {
    const a = A("go mod verify && go test ./...")
    expect(a.compiles).toBe(true)
    expect(a.executesProjectCode).toBe(true)
  })
})
