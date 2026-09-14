/**
 * CL-11.4A — pip install SOURCE & build classification, from the command alone.
 *
 * Measured 2026-07-24 (pip 26.0.1):
 *   - `--require-hashes` REFUSES any requirement without a hash, and auto-enables
 *     when any requirement carries one — so it is pip's integrity gate, the
 *     analog of a hash-pinned lockfile.
 *   - a source distribution builds by EXECUTING setup.py / the build backend;
 *     `--only-binary :all:` avoids that for INDEX installs (wheels only), but was
 *     measured NOT to help a LOCAL path (setup.py ran anyway).
 *   - git / URL / local-path / editable specs pull from outside the index.
 *
 * This module reports those facts; it decides nothing (4C enforces). The clean
 * deterministic subset it recognises is: an index install from a requirements
 * file under `--require-hashes`, with no git/url/local/editable source.
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import { assessPipInstallSource } from "../src/index"

const src = (command: string) => assessPipInstallSource(normalize(command, { shell: "bash" }).commands ?? [])

describe("CL-11.4A.1 pip is recognised in every spelling", () => {
  test("pip / pip3 / python -m pip install", () => {
    expect(src("pip install -r r.txt").isInstall).toBe(true)
    expect(src("pip3 install -r r.txt").isInstall).toBe(true)
    expect(src("python -m pip install -r r.txt").isInstall).toBe(true)
    expect(src("python3 -m pip install -r r.txt").isInstall).toBe(true)
    expect(src("pip list").isInstall).toBe(false)
    expect(src("npm ci").isInstall).toBe(false)
  })
})

describe("CL-11.4A.2 the clean subset: python -m pip + -r + --require-hashes + --only-binary", () => {
  test("`python -m pip install -r req.txt --require-hashes --only-binary=:all:` clears every blocker", () => {
    // The clean auto-allow subset requires `python -m pip` (a named interpreter),
    // `--require-hashes`, and `--only-binary :all:` (the one command-side proof of
    // no build). A bare `pip` cannot identify its environment — see 4C2 below.
    const a = src("python -m pip install -r requirements.txt --require-hashes --only-binary=:all:")
    expect(a.requireHashes).toBe(true)
    expect(a.hasRequirementsFile).toBe(true)
    expect(a.buildExecution).toBe("no")
    expect(a.target.viaPythonModule).toBe(true)
    expect(a.blockers).toEqual([])
  })

  test("WITHOUT --only-binary the build may execute => build_may_execute blocker", () => {
    const a = src("python -m pip install -r req.txt --require-hashes")
    expect(a.buildExecution).toBe("unknown")
    expect(a.blockers).toContain("build_may_execute")
  })
})

describe("CL-11.4C2 target identity blockers (command-side)", () => {
  const clean = "install -r req.txt --require-hashes --only-binary=:all:"
  test("a BARE pip cannot identify its interpreter => bare_pip_unknown_interpreter", () => {
    const a = src(`pip ${clean}`)
    expect(a.target.viaPythonModule).toBe(false)
    expect(a.blockers).toContain("bare_pip_unknown_interpreter")
  })

  test("--user / --prefix / --root write outside the project => blocked", () => {
    expect(src(`python -m pip ${clean} --user`).blockers).toContain("user_site_install")
    expect(src(`python -m pip ${clean} --prefix /opt`).blockers).toContain("custom_prefix")
    expect(src(`python -m pip ${clean} --root /sandbox`).blockers).toContain("custom_root")
  })

  test("--target names a destination (confinement is the verifier's call)", () => {
    const a = src(`pip ${clean} --target ./vendor`)
    expect(a.target.targetDir).toBe("./vendor")
    // With --target present, a bare pip is not blocked for interpreter identity.
    expect(a.blockers).not.toContain("bare_pip_unknown_interpreter")
  })

  test("the interpreter is captured (its real path is resolved by the verifier via VIRTUAL_ENV)", () => {
    // The normalizer resolves a wrapper path to the program name, so command-side
    // we only know it is `python -m pip`; WHICH python (and whether that env is
    // inside the workspace) is a filesystem/env fact the verifier decides.
    const a = src(`python3 -m pip ${clean}`)
    expect(a.target.viaPythonModule).toBe(true)
    expect(a.target.interpreter).toBe("python3")
  })
})

describe("CL-11.4A.3 missing hash-pinning blocks the clean path", () => {
  test("no --require-hashes => hashes_not_required", () => {
    const a = src("pip install -r requirements.txt")
    expect(a.requireHashes).toBe(false)
    expect(a.blockers).toContain("hashes_not_required")
  })

  test("a directly-named package resolves loosely => direct_unpinned_spec", () => {
    const a = src("pip install requests")
    expect(a.blockers).toContain("direct_unpinned_spec")
    expect(a.blockers).toContain("hashes_not_required")
  })
})

describe("CL-11.4A.4 non-index sources are named", () => {
  test("git / url / tarball / vcs", () => {
    expect(src("pip install git+https://github.com/x/y.git").sources.git).toBe(true)
    expect(src("pip install https://example.com/pkg.tar.gz").sources.url).toBe(true)
    expect(src("pip install hg+https://host/repo").sources.vcs).toBe(true)
    for (const cmd of ["pip install git+https://g/x.git", "pip install https://h/p.tar.gz", "pip install hg+https://h/r"]) {
      expect(src(cmd).blockers).toContain("non_index_source")
    }
  })

  test("a local path or an editable install", () => {
    expect(src("pip install ./localpkg").sources.localPath).toBe(true)
    expect(src("pip install .").sources.localPath).toBe(true)
    expect(src("pip install /abs/path").sources.localPath).toBe(true)
    expect(src("pip install -e .").sources.editable).toBe(true)
    for (const cmd of ["pip install ./localpkg", "pip install -e ."]) {
      expect(src(cmd).blockers).toContain("non_index_source")
    }
  })

  test("a plain index name is NOT a non-index source", () => {
    expect(src("pip install -r r.txt --require-hashes").sources.localPath).toBe(false)
    expect(src("pip install requests==2.31.0 --hash=sha256:abc").sources.git).toBe(false)
  })
})

describe("CL-11.4A.5 build execution verdict (setup.py / build backend)", () => {
  test("index install with --only-binary :all: runs no build (wheels only)", () => {
    expect(src("pip install -r r.txt --require-hashes --only-binary=:all:").buildExecution).toBe("no")
  })

  test("a git/url/local/editable source runs build code", () => {
    expect(src("pip install ./pkg").buildExecution).toBe("yes")
    expect(src("pip install git+https://g/x.git").buildExecution).toBe("yes")
    expect(src("pip install -e .").buildExecution).toBe("yes")
  })

  test("--only-binary :all: does NOT rescue a LOCAL path (measured)", () => {
    // The local build ran anyway 2026-07-23; the flag governs index resolution.
    expect(src("pip install ./pkg --only-binary=:all:").buildExecution).toBe("yes")
  })

  test("an index install with no --only-binary is UNKNOWN — it may build an sdist", () => {
    expect(src("pip install -r r.txt --require-hashes").buildExecution).toBe("unknown")
  })
})

describe("CL-11.4A.6 worst-wins across a chain", () => {
  test("one dirty pip install poisons the chain's blockers", () => {
    const a = src("pip install -r r.txt --require-hashes && pip install ./evil")
    expect(a.blockers).toContain("non_index_source")
  })
})
