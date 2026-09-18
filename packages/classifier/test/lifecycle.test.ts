/**
 * CL-11.1 gate — lifecycle scripts as a FACT, with the distinction that makes
 * the fact honest: IMPLICIT scripts vs an EXPLICIT one.
 *
 * `npm_config_ignore_scripts=true` (and `--ignore-scripts`) suppress the scripts
 * that fire AROUND a command without being asked for — a fetched package's
 * install hooks, and the project's own `pre`/`post` wrappers. Measured
 * 2026-07-23 they do NOT stop the script the user explicitly named:
 *
 *   npm test                 -> pretest, test, posttest all run
 *   IGNORE=true npm test     -> pretest/posttest suppressed, `test` STILL RAN
 *
 * So the classifier reports three things, not two:
 *   thirdPartyScripts      implicit, from fetched packages   (suppressible)
 *   implicitProjectScripts implicit, the project's pre/post   (suppressible)
 *   explicitScript         the named script the user invoked  (NOT suppressible)
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessLifecycleAll, assessLifecycleScripts } from "../src/index"

const commands = (command: string) => normalize(command, { shell: "bash" }).commands ?? []
const one = (command: string) => assessLifecycleScripts(commands(command)[0]!)
const all = (command: string) => assessLifecycleAll(commands(command))

describe("CL-11.1 an install runs implicit code, and no explicit script", () => {
  test("the JS installers: third-party hooks AND the project's own, but nothing explicit", () => {
    for (const cmd of ["npm install", "npm i", "npm ci", "npm install lodash", "pnpm add react", "bun install", "npm update", "npm rebuild"]) {
      const a = one(cmd)
      expect(a.thirdPartyScripts).toBe("yes")
      expect(a.implicitProjectScripts).toBe("yes")
      expect(a.explicitScript).toBe("no")
    }
  })

  test("a bare `yarn` installs — the command a verb-only table would miss", () => {
    const a = one("yarn")
    expect(a.thirdPartyScripts).toBe("yes")
    expect(one("npm").thirdPartyScripts).toBe("no")
  })

  test("non-JS managers still run third-party build code at install/compile time", () => {
    expect(one("pip install requests").thirdPartyScripts).toBe("yes")
    expect(one("poetry install").thirdPartyScripts).toBe("yes")
    expect(one("composer install").thirdPartyScripts).toBe("yes")
    expect(one("cargo build").thirdPartyScripts).toBe("yes")
    expect(one("gem install nokogiri").thirdPartyScripts).toBe("yes")
    expect(one("gradle assemble").thirdPartyScripts).toBe("yes")
    expect(one("mvn package").thirdPartyScripts).toBe("yes")
  })

  test("Go is the exception, stated precisely — but only for non-toolchain verbs", () => {
    // Go modules really do have no install hooks, and CL-11.6A measured that
    // compiling runs no PROJECT code. Verbs that never invoke the compiler are
    // therefore genuinely inert.
    expect(one("go list ./...").thirdPartyScripts).toBe("no")
    expect(one("go mod download").thirdPartyScripts).toBe("no")

    // `go generate` runs whatever a directive names — including a dependency's.
    expect(one("go generate ./...").thirdPartyScripts).toBe("yes")

    // CORRECTED by the CL-11-FINAL audit. `go build` and `go install` used to be
    // called inert, and that let bare `go build` and `go install` AUTO-ALLOW.
    // Any toolchain verb can be turned into arbitrary execution without changing
    // the command: 6A measured `GOFLAGS=-toolexec=<script> go build` running the
    // script, and `CC=<script>` running it for cgo. `go install` also writes an
    // executable into GOBIN, outside the workspace. Unknown, never "no".
    for (const cmd of ["go build ./...", "go build", "go install ./cmd/x", "go vet ./...", "go get example.com/x"]) {
      expect(one(cmd).thirdPartyScripts).toBe("unknown")
    }
  })
})

describe("CL-11.1b `npm run/test/start` is EXPLICIT execution, wrapped in implicit pre/post", () => {
  test("the named script is explicit; only its wrappers are implicit", () => {
    for (const cmd of ["npm test", "npm start", "npm run build", "npm run lint"]) {
      const a = one(cmd)
      expect(a.explicitScript).toBe("yes") // the user asked for THIS to run
      expect(a.implicitProjectScripts).toBe("yes") // pre<x>/post<x> fire around it
      expect(a.thirdPartyScripts).toBe("no") // nothing was fetched
    }
  })

  test("this is the correction: `npm test` does NOT let the constraint claim to block the test script", () => {
    // The whole point. Before the split, `npm test` reported `projectScripts:
    // yes` and the overlay claimed to suppress it — but ignore-scripts leaves the
    // test script running. The explicit script is now its own verdict.
    const a = one("npm test")
    expect(a.explicitScript).toBe("yes")
  })
})

describe("CL-11.2 suppression removes the IMPLICIT scripts, never the explicit one", () => {
  test("--ignore-scripts clears both implicit verdicts and the record says what would have run", () => {
    const a = one("npm install --ignore-scripts")
    expect(a.thirdPartyScripts).toBe("no")
    expect(a.implicitProjectScripts).toBe("no")
    expect(a.suppressedBy).toBe("--ignore-scripts")
    expect(a.reason).toContain("postinstall")
  })

  test("--ignore-scripts on an EXPLICIT command still leaves the named script running", () => {
    const a = one("npm test --ignore-scripts")
    expect(a.implicitProjectScripts).toBe("no") // pretest/posttest gone
    expect(a.explicitScript).toBe("yes") // the test script is NOT suppressed
  })

  test("a flag MEASURED NOT TO WORK does not suppress, and says so", () => {
    const a = one("pip install ./pkg --only-binary=:all:")
    expect(a.thirdPartyScripts).toBe("yes")
    expect(a.suppressedBy).toBeUndefined()
    expect(a.reason).toContain("does NOT stop them")
  })

  test("an UNMEASURED flag yields `unknown` on the implicit verdicts", () => {
    for (const cmd of ["composer install --no-scripts", "pnpm install --ignore-scripts"]) {
      const a = one(cmd)
      expect(a.thirdPartyScripts).toBe("unknown")
      expect(a.suppressedBy).toBeUndefined()
      expect(a.reason).toContain("not been verified")
    }
  })

  test("no borrowing between managers", () => {
    expect(one("pip install requests --ignore-scripts").thirdPartyScripts).toBe("yes")
    expect(one("cargo build --ignore-scripts").thirdPartyScripts).toBe("yes")
    expect(one("composer install --ignore-scripts").thirdPartyScripts).toBe("yes")
    expect(one("cargo build").reason).toContain("no ignore-scripts")
  })
})

describe("CL-11.3 unknown is unknown", () => {
  test("an unmodelled program is unknown on every verdict, not safe", () => {
    const a = one("nix-env -i hello")
    expect(a.thirdPartyScripts).toBe("unknown")
    expect(a.implicitProjectScripts).toBe("unknown")
    expect(a.explicitScript).toBe("unknown")
  })

  test("a known manager with an unmodelled verb is unknown", () => {
    const a = one("npm whoami")
    expect(a.manager).toBe("npm")
    expect(a.thirdPartyScripts).toBe("unknown")
  })

  test("no resolved command at all is unknown", () => {
    expect(assessLifecycleAll([]).thirdPartyScripts).toBe("unknown")
  })
})

describe("CL-11.4 a chain is as bad as its worst member, per verdict", () => {
  test("a read verb next to an install does not launder the install", () => {
    const a = all("npm ls && npm install")
    expect(a.thirdPartyScripts).toBe("yes")
    expect(a.manager).toBe("npm")
  })

  test("an explicit script in one member surfaces on the chain's explicit verdict", () => {
    const a = all("npm ci && npm test")
    expect(a.thirdPartyScripts).toBe("yes") // from the install
    expect(a.explicitScript).toBe("yes") // from the test
  })

  test("suppressing ONE install in a chain does not suppress the other", () => {
    expect(all("npm install --ignore-scripts && npm install").thirdPartyScripts).toBe("yes")
  })

  test("wrappers and cwd changes do not hide the install", () => {
    const a = all("cd packages/frontend && npm install")
    expect(a.thirdPartyScripts).toBe("yes")
    expect(a.manager).toBe("npm")
  })
})
