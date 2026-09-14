/**
 * RC4 §1 — reproduce the CONTROL test's two arms through the REAL harness call,
 * with the exact argument vector `appcontainer.test.ts` uses, and report where
 * the time goes. No assertions: this only measures.
 */
import { containerName, runUnelevated } from "../test/harness"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const DETACHER = [CMD, "/c", "start /b powershell -NoProfile -Command Start-Sleep -Seconds 40 & powershell -NoProfile -Command Start-Sleep -Seconds 40"]

const run = (tag: string, extra: string[]) => runUnelevated(["run", "--name", containerName(tag), ...extra, "--", ...DETACHER], 90_000)

for (const [label, extra] of [
  ["j1 CONTAINED (job)", ["--timeout-ms", "3000"]],
  ["j2 ESCAPED (--no-job)", ["--no-job", "--timeout-ms", "3000"]],
] as [string, string[]][]) {
  const t0 = Date.now()
  const r = await run(label.startsWith("j1") ? "j1" : "j2", extra)
  const wall = Date.now() - t0
  console.log(
    JSON.stringify({
      arm: label,
      wallMs: wall,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      ok: r.ok,
      stage: r.stage ?? null,
      errorCode: r.errorCode ?? null,
      exitCode: r.exitCode,
      assignedToJob: r.assignedToJob,
      isProcessInJob: r.isProcessInJob,
      isProcessInAnyJob: r.isProcessInAnyJob,
      jobDrained: r.jobDrained,
      jobMembersAfter: r.jobMembersAfter,
      consoleHostsReaped: r.consoleHostsReaped,
      stdoutLen: String(r.stdout ?? "").length,
      profileCreated: r.profileCreated,
      profileDeleted: r.profileDeleted,
    }),
  )
}
