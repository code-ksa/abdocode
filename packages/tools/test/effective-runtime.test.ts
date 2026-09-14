/**
 * CL-16A3-B §0.A — the effective runtime, with its false positives and its real
 * bypasses tested side by side.
 *
 * Both halves matter. A rule that refuses `cmd /c echo bash` is not "safe", it
 * is broken in a way that teaches people to route around the control; and a rule
 * that lets `cmd /c bash -c ...` through has failed at the only job it has.
 */
import { describe, expect, test } from "bun:test"
import { deriveEffectiveRuntime, powershellScriptInvokesShell, tokenizeCmdPayload } from "../src/effective-runtime"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
const NODE = "C:\\Program Files\\nodejs\\node.exe"

const dialectOf = (exe: string, argv: readonly string[]) => deriveEffectiveRuntime(exe, argv).dialect

describe("CL-16A3-B - FALSE POSITIVES: a mention of bash is not an invocation", () => {
  test("an ordinary argument whose VALUE is bash does not change the runtime", () => {
    // A direct executable IS the runtime; its arguments never change that.
    expect(dialectOf(NODE, ["-e", "console.log('bash')"])).toBe("direct")
    expect(dialectOf(NODE, ["--shell", "bash"])).toBe("direct")
    expect(dialectOf(NODE, ["bash"])).toBe("direct")
  })

  test("a FILE named bash.txt is not a shell", () => {
    expect(dialectOf(NODE, ["C:\\work\\bash.txt"])).toBe("direct")
    expect(dialectOf(CMD, ["/c", "type", "C:\\work\\bash.txt"])).toBe("cmd")
  })

  test("cmd /c echo bash is a cmd execution", () => {
    expect(dialectOf(CMD, ["/c", "echo", "bash"])).toBe("cmd")
    expect(dialectOf(CMD, ["/c", "echo bash"])).toBe("cmd")
  })

  test("a JSON payload mentioning bash is inert", () => {
    expect(dialectOf(NODE, ["-e", '{"shell":"bash","args":["-c"]}'])).toBe("direct")
    expect(dialectOf(CMD, ["/c", 'echo {"shell":"bash"}'])).toBe("cmd")
  })

  test("PowerShell printing the word bash is a powershell execution", () => {
    expect(dialectOf(PS, ["-NoProfile", "-Command", "Write-Output 'bash'"])).toBe("powershell")
    expect(dialectOf(PS, ["-NoProfile", "-Command", 'Write-Output "bash -c echo"'])).toBe("powershell")
    expect(powershellScriptInvokesShell("Write-Output 'bash'")).toBe(false)
  })
})

describe("CL-16A3-B - REAL BYPASSES: what actually runs is what counts", () => {
  test("cmd /c bash -c ... is bash", () => {
    const r = deriveEffectiveRuntime(CMD, ["/c", "bash", "-c", "echo pwned"])
    expect(r.dialect).toBe("bash")
    expect(r.reasonCodes).toContain("cmd_payload_invokes_posix_shell")
  })

  test("cmd /c call bash ... is bash", () => {
    expect(dialectOf(CMD, ["/c", "call", "bash", "-c", "echo x"])).toBe("bash")
    expect(dialectOf(CMD, ["/c", "call bash -c \"echo x\""])).toBe("bash")
  })

  test("cmd /c with a quoted absolute path to bash is bash", () => {
    expect(dialectOf(CMD, ["/c", `"${BASH}" -c "echo x"`])).toBe("bash")
  })

  test("PowerShell -Command \"& bash ...\" is not a plain powershell run", () => {
    const r = deriveEffectiveRuntime(PS, ["-NoProfile", "-Command", "& bash -c 'echo pwned'"])
    expect(r.dialect).toBe("unknown")
    expect(r.reasonCodes).toContain("powershell_script_may_invoke_posix_shell")
  })

  test("PowerShell Start-Process bash is not a plain powershell run", () => {
    expect(dialectOf(PS, ["-NoProfile", "-Command", "Start-Process bash"])).toBe("unknown")
  })

  test("a shell after a pipeline or statement separator is caught", () => {
    for (const script of ["Get-Date; bash -c 'x'", "Get-Date | bash", "if ($true) { bash -c 'x' }"]) {
      expect(powershellScriptInvokesShell(script)).toBe(true)
    }
  })

  test("bash named directly is bash, however it is spelled", () => {
    for (const b of ["bash", "bash.exe", BASH, "/bin/sh", "zsh"]) expect(dialectOf(b, ["-c", "echo x"])).toBe("bash")
  })
})

describe("CL-16A3-B - declared limits, not hidden ones", () => {
  test("-EncodedCommand is never passed through as a black box", () => {
    const r = deriveEffectiveRuntime(PS, ["-NoProfile", "-EncodedCommand", "ZQBjAGgAbwA="])
    expect(r.dialect).toBe("unknown")
    expect(r.analysable).toBe(false)
    expect(r.reasonCodes).toContain("powershell_encoded_command_not_supported")
  })

  test("-File is powershell, but its scope still has to be proven elsewhere", () => {
    const r = deriveEffectiveRuntime(PS, ["-NoProfile", "-File", "C:\\AbdoExec\\run.ps1"])
    expect(r.dialect).toBe("powershell")
    expect(r.effectiveExecutable).toBe("C:\\AbdoExec\\run.ps1")
    expect(r.reasonCodes).toContain("powershell_file_scope_must_be_proven")
  })

  test("a bare PATH-resolved name is unknown, not direct", () => {
    for (const bare of ["node", "python", "tool.exe"]) {
      const r = deriveEffectiveRuntime(bare, [])
      expect(r.dialect).toBe("unknown")
      expect(r.reasonCodes).toContain("executable_not_absolute")
    }
  })

  test("cmd payload tokenizing respects quotes", () => {
    expect(tokenizeCmdPayload('"C:\\a b\\x.exe" -c "hello world"')).toEqual(["C:\\a b\\x.exe", "-c", "hello world"])
    expect(tokenizeCmdPayload("echo   bash")).toEqual(["echo", "bash"])
  })

  test("cmd without /c or /k interprets nothing", () => {
    expect(dialectOf(CMD, [])).toBe("cmd")
    expect(dialectOf(CMD, ["/v:on"])).toBe("cmd")
  })
})
