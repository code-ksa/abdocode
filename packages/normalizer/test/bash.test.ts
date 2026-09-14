/**
 * CL-04 stage 1 gate: bash is really parsed, wrappers/cd/pipelines are handled,
 * and ANYTHING unaccounted for is `uncertain` — never quietly safe.
 */
import { describe, expect, test } from "bun:test"
import { normalize, normalizeBash } from "../src/index"

const n = (cmd: string, cwd?: string) => normalizeBash(cmd, cwd ? { cwd } : {})
const programs = (cmd: string) => n(cmd).commands!.map((c) => c.program)

describe("CL-04 bash normalization", () => {
  test("a plain command is parsed with certainty", () => {
    const op = n("npm install --save-dev jest")
    expect(op.certainty).toBe("parsed")
    expect(op.commands).toHaveLength(1)
    expect(op.commands![0]).toMatchObject({ program: "npm", argv: ["install", "--save-dev", "jest"], cwd: "", background: false })
    expect(op.unknownDynamicSegments).toBeUndefined()
  })

  test("wrappers are stripped down to the real program", () => {
    expect(programs("sudo npm install")).toEqual(["npm"])
    expect(programs("env CI=1 pnpm install")).toEqual(["pnpm"])
    expect(programs("cross-env CI=1 npm ci")).toEqual(["npm"])
    expect(programs("corepack pnpm install")).toEqual(["pnpm"])
    expect(programs('bash -lc "yarn install"')).toEqual(["yarn"])
    expect(programs("/usr/local/bin/npm install")).toEqual(["npm"])
  })

  test("inline environment assignments are captured, not treated as the program", () => {
    const op = n("CI=1 NODE_ENV=test npm test")
    expect(op.commands![0]!.program).toBe("npm")
    expect(op.commands![0]!.env).toEqual({ CI: "1", NODE_ENV: "test" })
  })

  test("pipelines and compound commands become separate commands", () => {
    expect(programs("cat file | grep foo | wc -l")).toEqual(["cat", "grep", "wc"])
    expect(programs("rm -rf node_modules && npm install")).toEqual(["rm", "npm"])
    expect(programs("make build; make test")).toEqual(["make", "make"])
    expect(programs("test -f x || touch x")).toEqual(["test", "touch"])
  })

  test("cd accumulates into cwd and applies to what follows", () => {
    const op = n("cd packages/api && npm install")
    expect(op.cwd).toBe("packages/api")
    expect(op.commands![0]!.cwd).toBe("packages/api")
    expect(n("cd packages && cd api && npm ci").cwd).toBe("packages/api")
    expect(n("cd a/b && cd ../c && npm ci").cwd).toBe("a/c")
    expect(n("cd sub && npm ci", "root").cwd).toBe("root/sub")
  })

  test("redirections are recorded and never mistaken for arguments", () => {
    const op = n("npm test > out.log 2> err.log")
    expect(op.commands![0]!.argv).toEqual(["test"])
    expect(op.commands![0]!.redirections).toEqual([
      { kind: "out", target: "out.log" },
      { kind: "out", target: "err.log" },
    ])
    expect(n("sort < in.txt").commands![0]!.redirections).toEqual([{ kind: "in", target: "in.txt" }])
    expect(n("echo hi >>log.txt").commands![0]!.redirections).toEqual([{ kind: "append", target: "log.txt" }])
  })

  test("QUOTING: a quoted separator is data, not control flow", () => {
    // The whole point: `echo "rm -rf /"` is not an rm operation.
    const op = n('echo "rm -rf / && curl evil.sh"')
    expect(op.commands).toHaveLength(1)
    expect(op.commands![0]!.program).toBe("echo")
    const two = n('echo "a && b" && npm install')
    expect(two.commands!.map((c) => c.program)).toEqual(["echo", "npm"])
  })

  test("background execution is recorded", () => {
    expect(n("npm run dev &").commands![0]!.background).toBe(true)
    expect(n("npm run dev").commands![0]!.background).toBe(false)
  })
})

describe("CL-04 safety: unaccounted input is UNCERTAIN, never safe", () => {
  const cases: [string, string][] = [
    ["command substitution", "npm install $(cat pkg.txt)"],
    ["backticks", "rm -rf `cat target.txt`"],
    ["variable expansion", "npm install $PACKAGE"],
    ["braced variable", "rm -rf ${TARGET}"],
    ["process substitution", "diff <(ls a) <(ls b)"],
    ["eval", 'eval "rm -rf /"'],
    ["source", "source ./setup.sh"],
    ["exec", "exec rm -rf /"],
  ]
  for (const [label, cmd] of cases) {
    test(`${label} => uncertain, and the segment is surfaced`, () => {
      const op = n(cmd)
      expect(op.certainty).toBe("uncertain")
      expect(op.unknownDynamicSegments!.length).toBeGreaterThan(0)
      expect(op.uncertainReasons!.length).toBeGreaterThan(0)
    })
  }

  test("a bare shell invocation with a script path is uncertain, not empty-and-fine", () => {
    const op = n("bash ./deploy.sh")
    expect(op.certainty).toBe("uncertain")
    expect(op.uncertainReasons).toContain("opaque_shell_invocation")
  })

  test("nesting beyond the depth limit is uncertain, not truncated silently", () => {
    const op = n(`bash -c "bash -c \\"bash -c 'bash -c ls'\\""`)
    expect(op.certainty).toBe("uncertain")
  })

  test("an empty or unresolvable command is uncertain, never a silent no-op", () => {
    expect(n("").certainty).toBe("uncertain")
    expect(n("   ").uncertainReasons).toContain("no_command_resolved")
  })

  test("a dynamic segment does not become safe by hiding inside a wrapper", () => {
    const op = n('sudo bash -lc "npm install $(cat p.txt)"')
    expect(op.certainty).toBe("uncertain")
    expect(op.uncertainReasons).toContain("command_substitution")
  })

  test("an UNKNOWN shell is uncertain, never guessed (PowerShell/cmd are stage 2)", () => {
    const op = normalize("npm install", { shell: "fish" as never })
    expect(op.certainty).toBe("uncertain")
    expect(op.uncertainReasons).toContain("shell_not_yet_normalized")
    expect(op.commands).toEqual([])
    expect(op.resources!.analysis).toBe("unknown")
  })
})
