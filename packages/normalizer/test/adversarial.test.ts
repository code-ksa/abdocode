/**
 * CL-04 adversarial corpus.
 *
 * Every case here is a way a second command, a destructive verb, or an
 * unknowable value can hide from a parser: quoting, nested shells, escaped
 * separators, multiline input, and Windows paths. The rule under test is always
 * the same — either we account for it exactly, or the operation is `uncertain`.
 * There is no third outcome.
 *
 * Several cases are carried over from abdo's shell handling so problems it
 * already solved are not reintroduced (see windows.ts header).
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "../src/index"

/** A literal backslash, built unambiguously so the corpus cannot be mangled. */
const BS = String.fromCharCode(92)
const bash = (c: string) => normalize(c, { shell: "bash" })
const ps = (c: string) => normalize(c, { shell: "powershell" })
const cmd = (c: string) => normalize(c, { shell: "cmd" })
const progs = (op: ReturnType<typeof bash>) => op.commands!.map((c) => c.program)

describe("adversarial: quoting", () => {
  test("a separator inside quotes never creates a second command", () => {
    expect(progs(bash('echo "a; rm -rf /"'))).toEqual(["echo"])
    expect(progs(ps('Write-Output "a; Remove-Item -Recurse temp"'))).toEqual(["write-output"])
    expect(progs(cmd('echo "a & del /f /s /q temp"'))).toEqual(["echo"])
  })

  test("single quotes are literal in bash and PowerShell; cmd has no single-quote form", () => {
    expect(progs(bash("echo 'a && b'"))).toEqual(["echo"])
    expect(progs(ps("Write-Output 'a; b'"))).toEqual(["write-output"])
    expect(progs(cmd("echo 'a b'"))).toEqual(["echo"])
  })

  test("an unterminated quote does not swallow the rest into a phantom command", () => {
    expect(bash('echo "unterminated && npm install').commands!.length).toBeLessThanOrEqual(1)
  })
})

describe("adversarial: escaped separators", () => {
  test("bash backslash-escaped separators are data, not control flow", () => {
    expect(progs(bash("echo a" + BS + ";b"))).toEqual(["echo"])
    expect(progs(bash("echo a " + BS + "&" + BS + "& b"))).toEqual(["echo"])
  })

  test("PowerShell escapes with a BACKTICK — a backslash is a path separator", () => {
    expect(progs(ps("Write-Output a`;b"))).toEqual(["write-output"])
    const p = "C:" + BS + "Users" + BS + "admin" + BS + "file.txt"
    expect(ps("Get-Item " + p).commands![0]!.argv).toEqual([p])
  })

  test("cmd escapes with ^ — a backslash is part of the path", () => {
    expect(progs(cmd("echo a^&b"))).toEqual(["echo"])
    const p = "C:" + BS + "Windows" + BS + "System32" + BS + "drivers" + BS + "etc" + BS + "hosts"
    expect(cmd("type " + p).commands![0]!.argv).toEqual([p])
  })
})

describe("adversarial: Windows paths survive intact", () => {
  const paths = [
    "C:" + BS + "Program Files" + BS + "nodejs" + BS + "npm.cmd",
    BS + BS + "server" + BS + "share" + BS + "file.txt",
    "D:/mixed" + BS + "separators/file.txt",
    "C:" + BS + "Users" + BS + "me" + BS + ".config" + BS + "app.json",
  ]
  for (const p of paths) {
    test("path is not mangled by escape handling: " + p, () => {
      const quoted = p.includes(" ") ? '"' + p + '"' : p
      expect(ps("Get-Content " + quoted).commands![0]!.argv).toEqual([p])
      expect(cmd("type " + quoted).commands![0]!.argv).toEqual([p])
    })
  }

  test("cd with a drive-qualified path REPLACES the cwd rather than appending", () => {
    expect(cmd("cd /d C:" + BS + "build & npm ci").cwd).toBe("C:/build")
    expect(ps("Set-Location C:" + BS + "build; npm ci").cwd).toBe("C:/build")
  })

  test("in cmd a leading / is a FLAG, not a directory (abdo lesson)", () => {
    expect(cmd("cd /d C:" + BS + "x").cwd).toBe("C:/x")
  })
})

describe("adversarial: nested shells", () => {
  test("a command nested one level down is still resolved", () => {
    expect(progs(bash('bash -lc "npm install"'))).toEqual(["npm"])
    expect(progs(cmd('cmd /c "npm ci"'))).toEqual(["npm"])
    expect(progs(ps('powershell -Command "npm ci"'))).toEqual(["npm"])
    expect(progs(ps('powershell -NoProfile -ExecutionPolicy Bypass -Command "npm ci"'))).toEqual(["npm"])
  })

  test("a dangerous command hidden two levels down is still surfaced", () => {
    const op = bash('sudo bash -lc "cd /tmp && rm -rf /var/data"')
    expect(progs(op)).toEqual(["rm"])
    expect(op.cwd).toBe("/tmp")
  })

  test("a script FILE is opaque, never an empty-and-fine parse", () => {
    for (const op of [bash("bash ./deploy.sh"), ps("powershell -File ." + BS + "deploy.ps1"), cmd("cmd /c deploy.bat")]) {
      expect(op.certainty).toBe("uncertain")
    }
  })
})

describe("adversarial: multiline", () => {
  test("newlines separate commands in every shell", () => {
    expect(progs(bash("cd api\nnpm ci\nnpm test"))).toEqual(["npm", "npm"])
    expect(progs(ps("Set-Location api\nnpm ci"))).toEqual(["npm"])
    expect(progs(cmd("cd api\r\nnpm ci"))).toEqual(["npm"])
  })

  test("cwd from an earlier line applies to later ones", () => {
    expect(bash("cd packages/api\nnpm ci").commands![0]!.cwd).toBe("packages/api")
  })

  test("a dangerous line buried in a multiline script is found", () => {
    expect(progs(bash("echo start\nnpm ci\nrm -rf /var/data\necho done"))).toContain("rm")
  })
})

describe("adversarial: expansion is UNCERTAIN in every shell", () => {
  const cases: [string, ReturnType<typeof bash>][] = [
    ["bash $VAR", bash("rm -rf $TARGET")],
    ["bash $(...)", bash("npm install $(cat p.txt)")],
    ["ps $var", ps("Remove-Item -Recurse $target")],
    ["ps $env:", ps("Remove-Item $env:TEMP")],
    ["ps $( )", ps("npm install $(Get-Content p.txt)")],
    ["ps @( )", ps("ForEach-Object @(1,2)")],
    ["ps script block", ps("& { Remove-Item -Recurse temp }")],
    ["ps iex", ps("Invoke-Expression $payload")],
    ["cmd %VAR%", cmd("del /f /s /q %TARGET%")],
    ["cmd delayed", cmd("del !TARGET!")],
    ["cmd call", cmd("call other.bat")],
  ]
  for (const [label, op] of cases) {
    test(label + " => uncertain with a reason", () => {
      expect(op.certainty).toBe("uncertain")
      expect(op.uncertainReasons!.length).toBeGreaterThan(0)
    })
  }
})

describe("resources: unfilled analysis says UNKNOWN, never an empty effect", () => {
  test("no visible redirection reports unknown, NOT 'writes nothing'", () => {
    for (const op of [bash("rm -rf build"), ps("Remove-Item -Recurse build"), cmd("del /s build")]) {
      expect(op.resources!.analysis).toBe("unknown")
      expect(op.resources!.writes).toBeUndefined() // not []
      expect(op.resources!.reads).toBeUndefined()
      expect(op.resources!.networkHints).toBeUndefined()
    }
  })

  test("a redirection gives PARTIAL analysis — still not complete", () => {
    const op = bash("npm test > out.log < in.txt")
    expect(op.resources!.analysis).toBe("partial")
    expect(op.resources!.writes).toEqual(["out.log"])
    expect(op.resources!.reads).toEqual(["in.txt"])
  })

  test("a glob target is not reported as a known path (abdo lesson)", () => {
    expect(ps("Get-Content x > out-*.log").resources!.analysis).toBe("unknown")
  })

  test("NOTHING reports complete analysis yet — that is CL-05", () => {
    for (const op of [bash("ls"), ps("Get-ChildItem"), cmd("dir"), bash("npm test > x.log")]) {
      expect(op.resources!.analysis).not.toBe("complete")
    }
  })
})
