/**
 * P7/P8 gap 1 — the array-argv claim, PROVEN instead of asserted.
 *
 * `spawnHelper`'s documentation claims "argv passed as an ARRAY — there is no
 * shell, so no quoting or metacharacter surface exists at all." The survey's
 * point is that this was architectural, not proven: no test ever pushed argv
 * elements containing spaces, embedded quotes, `&`, `|`, `>`, `^` or `%`
 * through the spawn primitive and checked what the child actually received.
 *
 * TWO LANES, one per phase that owns this gap:
 *
 *  - P7 (the dialect contract of the primitive): the same spawn shape
 *    `spawnHelper` uses — `Bun.spawnSync([absolutePath, ...argv])`, explicit
 *    env, no shell — with a child that ECHOES its argv back as JSON. Every
 *    hostile element must arrive VERBATIM. Both the child (bun) and the helper
 *    (Rust std) parse their command line with the same Windows C-runtime rules,
 *    so what bun receives is what the helper receives.
 *
 *  - P8 (the production runner): `directHelperRunner` fed a hostile argv[0].
 *    The REAL helper must come back with its structured `ok:false` usage
 *    refusal at exit 0 and protocol 10 — the proof that no shell ever saw the
 *    string: under cmd, `&` and `|` would have split it into commands and the
 *    process shape itself would differ.
 *
 * The one hostile shape deliberately NOT claimed: an argv element containing a
 * literal `"` adjacent to backslashes exercises CommandLineToArgvW's escaping
 * rules; the elements below include it so a regression in Bun's quoting layer
 * is caught here, not in production.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { directHelperRunner } from "../src/helper-runner"

const T = 60_000
const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")

/** The metacharacter set the survey names, plus the quoting edge cases. */
const HOSTILE: readonly string[] = [
  "has two  spaces",
  'embedded"quote',
  "amp&split",
  "pipe|split",
  "redirect>out.txt",
  "caret^escape",
  "%PATH%", // must arrive literally: only cmd expands %VAR%
  "trailing\\",
  "back\\\\slashes\\before\"quote",
  "$env:PATH", // must arrive literally: only PowerShell expands $env:
  "`backtick`",
  "(parens) [brackets] {braces}",
]

describe.skipIf(process.platform !== "win32")("P7/P8 gap 1 — hostile argv passes through verbatim", () => {
  test("P7: every hostile element reaches a real child EXACTLY as sent (no shell, no expansion)", () => {
    // A sentinel marks where the payload begins, so the assertion does not
    // depend on how the runtime lays out its own leading argv entries.
    const SENTINEL = "ARGV_PAYLOAD_STARTS_HERE"
    const p = Bun.spawnSync(
      [process.execPath, "-e", "console.log(JSON.stringify(process.argv))", SENTINEL, ...HOSTILE],
      { stdout: "pipe", stderr: "pipe", timeout: T, env: { ...process.env } },
    )
    expect(p.exitCode).toBe(0)
    const argv = JSON.parse(p.stdout.toString().trim()) as string[]
    const at = argv.indexOf(SENTINEL)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(argv.slice(at + 1)).toEqual([...HOSTILE])
  }, T)

  test("P8: the production runner hands a hostile argv[0] to the REAL helper, which refuses structurally", async () => {
    const run = directHelperRunner(HELPER)
    const hostile = 'hostile & | > ^ %PATH% "quoted"'
    const r = await run({ argv: [hostile], timeoutMs: T })
    // The helper answered (exit 0 — a non-zero exit would have thrown
    // HelperExitContractViolated), refused inside the payload, and speaks the
    // pinned protocol: no shell interposed, nothing executed, nothing split.
    expect(r.ok).toBe(false)
    expect(r.protocolVersion).toBe(10)
    expect(r.stage).toBe("args")
  }, T)

  test("P8: the refusal left no residue — no cmd.exe was spawned to interpret anything", async () => {
    // If a shell HAD been interposed, `redirect>out.txt` in the P7 lane would
    // have created a file next to the child's cwd. Prove the absence.
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(process.cwd(), "out.txt"))).toBe(false)
  })
})
