/**
 * Sprint 22 GATE — no nested heredocs between PowerShell, SSH and Bash.
 *
 * The protocol is exercised end to end against a LOCAL channel that behaves
 * like a remote host: real files, a real sha256, a real interpreter, real
 * cleanup. What makes it a gate rather than a demo is the script it carries —
 * a script full of exactly the things that do not survive being folded into a
 * command string: single and double quotes, a heredoc of its own, `$(...)`,
 * backticks, backslashes, Arabic and an emoji.
 *
 * If any layer were re-parsing the text, this script would not arrive intact,
 * and the digest check would say so before it ran.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasNestedQuoting, runRemoteScript, sshArgv, withArgumentPrologue, type ExecChannel } from "../src/ssh-transport"

/**
 * A stand-in for the far side. It understands the four commands the protocol
 * uses — `dd of=`, `sha256sum`, the interpreter, and `rm -f` — and nothing
 * else, which is the point: if the transport ever needed a shell, this channel
 * could not serve it.
 */
function localChannel(root: string): ExecChannel & { seen: string[][] } {
  const seen: string[][] = []
  return {
    seen,
    describe: "local",
    async exec({ argv, stdin }) {
      seen.push([...argv])
      // strip the ssh prefix: ["ssh", ...opts, "--", host, ...remote]
      const sep = argv.indexOf("--")
      const remote = argv.slice(sep + 2)
      const [program, ...rest] = remote

      if (program === "dd") {
        const target = (rest.find((a) => a.startsWith("of=")) ?? "of=").slice(3)
        writeFileSync(join(root, target.replace(/^\/tmp\//, "")), stdin ?? "")
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (program === "sha256sum") {
        const path = join(root, (rest[0] ?? "").replace(/^\/tmp\//, ""))
        if (!existsSync(path)) return { exitCode: 1, stdout: "", stderr: "no such file" }
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
        return { exitCode: 0, stdout: `${digest}  ${rest[0]}\n`, stderr: "" }
      }
      if (program === "rm") {
        const path = join(root, (rest[rest.length - 1] ?? "").replace(/^\/tmp\//, ""))
        try {
          rmSync(path, { force: true })
        } catch {
          /* -f means a missing file is not an error */
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      // the interpreter: run the FILE, exactly as the remote would
      const path = join(root, (rest[0] ?? "").replace(/^\/tmp\//, ""))
      const proc = Bun.spawnSync([program!, path, ...rest.slice(1)], { stdout: "pipe", stderr: "pipe" })
      return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      }
    },
  }
}

/** Everything that dies when text is folded through three layers of quoting. */
const HOSTILE_SCRIPT = [
  "// a script that would not survive being folded into a command string",
  "const single = 'single quotes'",
  'const double = "double quotes"',
  "const dollar = '$(whoami)'",
  "const backtick = '`hostname`'",
  "const backslash = 'C:\\\\Users\\\\a b'",
  "const arabic = 'مرحبا بالعالم'",
  "const emoji = '🚀'",
  "const heredoc = `",
  "cat <<'EOF'",
  "this is a heredoc INSIDE the script",
  "EOF",
  "`",
  "console.log(JSON.stringify({ single, double, dollar, backtick, backslash, arabic, emoji, heredocLen: heredoc.length }))",
].join("\n")

function withRemote(fn: (ctx: { root: string; channel: ExecChannel & { seen: string[][] } }) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "abdo-ssh-"))
    try {
      await fn({ root, channel: localChannel(root) })
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* Windows may briefly hold a handle */
      }
    }
  }
}

const target = { host: "example-host", interpreter: process.execPath }

describe("GATE — nothing is folded into a command string", () => {
  test("no step's argv contains a heredoc, a substitution or an escaped quote", async () => {
    const seen: string[][] = []
    const channel: ExecChannel = {
      describe: "recorder",
      async exec({ argv }) {
        seen.push([...argv])
        return { exitCode: 0, stdout: "0".repeat(64) + "  x", stderr: "" }
      },
    }
    // a digest that will not match, so it stops after verify — we only want argv
    await runRemoteScript({ channel, target, script: HOSTILE_SCRIPT, scriptName: "s.sh" })

    expect(seen.length).toBeGreaterThan(0)
    for (const argv of seen) {
      expect(hasNestedQuoting(argv)).toBe(false)
      // the script itself never appears as an argument, only as stdin
      expect(argv.join(" ")).not.toContain("console.log")
    }
  })

  test("ssh's own option parsing is ended before the host, so a dashed host is not a flag", () => {
    const argv = sshArgv({ host: "-oProxyCommand=evil" }, ["true"])
    expect(argv.indexOf("--")).toBeGreaterThan(0)
    expect(argv.indexOf("--")).toBeLessThan(argv.indexOf("-oProxyCommand=evil"))
  })

  test("the nesting detector recognises what it is meant to catch", () => {
    expect(hasNestedQuoting(["bash", "-lc", "cat <<'EOF'\nx\nEOF"])).toBe(true)
    expect(hasNestedQuoting(["bash", "-lc", "echo $(whoami)"])).toBe(true)
    expect(hasNestedQuoting(["bash", "-lc", "echo `hostname`"])).toBe(true)
    expect(hasNestedQuoting(["bash", "-lc", 'echo \\"hi\\"'])).toBe(true)
    expect(hasNestedQuoting(["dd", "of=/tmp/a.sh", "status=none"])).toBe(false)
    expect(hasNestedQuoting(["sha256sum", "/tmp/a.sh"])).toBe(false)
  })
})

describe("the five steps, against a real filesystem", () => {
  test(
    "a hostile script arrives byte-identical, runs, and is cleaned up",
    withRemote(async ({ root, channel }) => {
      const receipt = await runRemoteScript({ channel, target, script: HOSTILE_SCRIPT, scriptName: "hostile.mjs" })

      expect(receipt.uploaded).toBe(true)
      expect(receipt.verified).toBe(true)
      expect(receipt.verifiedDigest).toBe(receipt.digest)
      expect(receipt.executed).toBe(true)
      expect(receipt.exitCode).toBe(0)

      // the script's own output proves every hostile construct survived
      const parsed = JSON.parse(receipt.stdout.trim()) as Record<string, unknown>
      expect(parsed.single).toBe("single quotes")
      expect(parsed.double).toBe("double quotes")
      expect(parsed.dollar).toBe("$(whoami)")
      expect(parsed.backtick).toBe("`hostname`")
      expect(parsed.backslash).toBe("C:\\Users\\a b")
      expect(parsed.arabic).toBe("مرحبا بالعالم")
      expect(parsed.emoji).toBe("🚀")

      // cleaned on success
      expect(receipt.cleaned).toBe(true)
      expect(existsSync(join(root, "hostile.mjs"))).toBe(false)
      expect(receipt.keptForDiagnosis).toBeUndefined()
    }),
  )

  test(
    "a failing script is KEPT, because a failure nobody can reproduce is worse",
    withRemote(async ({ root, channel }) => {
      const receipt = await runRemoteScript({
        channel,
        target,
        script: "console.error('it broke'); process.exit(3)\n",
        scriptName: "fails.mjs",
      })

      expect(receipt.executed).toBe(true)
      expect(receipt.exitCode).toBe(3)
      expect(receipt.stderr).toContain("it broke")
      expect(receipt.cleaned).toBe(false)
      expect(receipt.keptForDiagnosis).toContain("fails.mjs")
      expect(existsSync(join(root, "fails.mjs"))).toBe(true)
    }),
  )

  test(
    "arguments reach the script as arguments",
    withRemote(async ({ channel }) => {
      const receipt = await runRemoteScript({
        channel,
        target,
        script: "console.log(JSON.stringify(process.argv.slice(2)))\n",
        args: ["a b", "$HOME", "--flag=x y"],
        scriptName: "args.mjs",
      })
      expect(JSON.parse(receipt.stdout.trim())).toEqual(["a b", "$HOME", "--flag=x y"])
    }),
  )

  test("a digest mismatch stops BEFORE the script runs", async () => {
    let executed = false
    const channel: ExecChannel = {
      describe: "tamperer",
      async exec({ argv }) {
        const sep = argv.indexOf("--")
        const program = argv[sep + 2]
        if (program === "dd") return { exitCode: 0, stdout: "", stderr: "" }
        if (program === "sha256sum") return { exitCode: 0, stdout: `${"a".repeat(64)}  /tmp/x.sh`, stderr: "" }
        executed = true
        return { exitCode: 0, stdout: "should never happen", stderr: "" }
      },
    }
    const receipt = await runRemoteScript({ channel, target, script: "console.log(1)", scriptName: "x.sh" })

    expect(executed).toBe(false)
    expect(receipt.verified).toBe(false)
    expect(receipt.executed).toBe(false)
    expect(receipt.failure).toContain("digest mismatch")
    // and the evidence is kept
    expect(receipt.keptForDiagnosis).toContain("x.sh")
  })

  test("an upload that fails never claims to have verified anything", async () => {
    const channel: ExecChannel = {
      describe: "broken",
      async exec() {
        return { exitCode: 1, stdout: "", stderr: "connection refused" }
      },
    }
    const receipt = await runRemoteScript({ channel, target, script: "x", scriptName: "y.sh" })
    expect(receipt.uploaded).toBe(false)
    expect(receipt.verified).toBe(false)
    expect(receipt.executed).toBe(false)
    expect(receipt.failure).toContain("connection refused")
  })

  test(
    "the receipt reports the steps in order, and the log can be replayed",
    withRemote(async ({ channel }) => {
      await runRemoteScript({ channel, target, script: "console.log('ok')\n", scriptName: "ok.mjs" })
      const programs = channel.seen.map((argv) => argv[argv.indexOf("--") + 2])
      expect(programs).toEqual(["dd", "sha256sum", process.execPath, "rm"])
    }),
  )
})

describe("arguments travel where quoting can be trusted", () => {
  test("for a POSIX shell they go INSIDE the verified payload", () => {
    const withArgs = withArgumentPrologue("echo \"$1\"\n", ["$HOME", "a b", "it's"])
    // the POSIX idiom: close the quote, escape one, reopen — 'it'\''s'
    expect(withArgs.split("\n")[0]).toBe("set -- '$HOME' 'a b' 'it'" + String.raw`\'` + "'s'")
    // the original script follows, untouched
    expect(withArgs).toContain('echo "$1"')
  })

  test("a shebang keeps line 1", () => {
    const withArgs = withArgumentPrologue("#!/usr/bin/env bash\nset -e\necho hi\n", ["x"])
    const lines = withArgs.split("\n")
    expect(lines[0]).toBe("#!/usr/bin/env bash")
    expect(lines[1]).toBe("set -- 'x'")
  })

  test("no arguments means no prologue at all", () => {
    expect(withArgumentPrologue("echo hi\n", [])).toBe("echo hi\n")
  })

  test(
    "the receipt says which transport carried them, so nobody has to assume",
    withRemote(async ({ channel }) => {
      const node = await runRemoteScript({
        channel,
        target,
        script: "console.log(JSON.stringify(process.argv.slice(2)))\n",
        args: ["x"],
        scriptName: "n.mjs",
      })
      // a non-shell interpreter cannot take a `set --` prologue
      expect(node.argumentTransport).toBe("command_line")

      const none = await runRemoteScript({ channel, target, script: "console.log(1)\n", scriptName: "none.mjs" })
      expect(none.argumentTransport).toBe("none")

      // A recorder, because this box has no /bin/bash to actually run — the
      // claim under test is which transport was CHOSEN, not the execution.
      let uploaded = ""
      const recorder: ExecChannel = {
        describe: "recorder",
        async exec({ argv, stdin }) {
          const sep = argv.indexOf("--")
          if (argv[sep + 2] === "sha256sum") {
            return { exitCode: 0, stdout: createHash("sha256").update(uploaded, "utf8").digest("hex") + "  x", stderr: "" }
          }
          if (stdin !== undefined) uploaded = stdin
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const shell = await runRemoteScript({
        channel: recorder,
        target: { host: "h", interpreter: "/bin/bash" },
        script: "echo hi\n",
        args: ["$HOME"],
        scriptName: "s.sh",
      })
      expect(shell.argumentTransport).toBe("payload")
      expect(uploaded).toContain("set -- '$HOME'")
    }),
  )

  test("the payload is what gets hashed, so the arguments are covered by the digest", async () => {
    const seen: { stdin?: string }[] = []
    const channel: ExecChannel = {
      describe: "recorder",
      async exec({ argv, stdin }) {
        seen.push({ stdin })
        const sep = argv.indexOf("--")
        if (argv[sep + 2] === "sha256sum") {
          const payload = seen[0]!.stdin ?? ""
          const digest = createHash("sha256").update(payload, "utf8").digest("hex")
          return { exitCode: 0, stdout: `${digest}  x`, stderr: "" }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    }
    const receipt = await runRemoteScript({
      channel,
      target: { host: "h", interpreter: "bash" },
      script: "echo hi\n",
      args: ["secret arg"],
      scriptName: "p.sh",
    })
    expect(receipt.verified).toBe(true)
    // the uploaded bytes include the arguments
    expect(seen[0]!.stdin).toContain("set -- 'secret arg'")
  })
})
