/**
 * RC4 §1 — why does the CONTROL arm's `cmd.exe` exit 1 immediately, and what
 * holds the run open for 40 s afterwards? Measurement only, no assertions.
 */
import { containerName, runUnelevated } from "../test/harness"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PSABS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const DETACH_BARE = "start /b powershell -NoProfile -Command Start-Sleep -Seconds 40 & powershell -NoProfile -Command Start-Sleep -Seconds 40"
const DETACH_ABS = `start /b ${PSABS} -NoProfile -Command Start-Sleep -Seconds 40 & ${PSABS} -NoProfile -Command Start-Sleep -Seconds 40`

const cases: [string, string[], string[]][] = [
  ["A appcontainer + job, BARE powershell (the test's exact command)", ["--timeout-ms", "3000"], [CMD, "/c", DETACH_BARE]],
  ["B plain + job, BARE powershell", ["--mode", "plain", "--timeout-ms", "3000"], [CMD, "/c", DETACH_BARE]],
  ["C plain + job, ABSOLUTE powershell", ["--mode", "plain", "--timeout-ms", "3000"], [CMD, "/c", DETACH_ABS]],
  ["D plain + job, NO detach (sleeper only, absolute)", ["--mode", "plain", "--timeout-ms", "3000"], [CMD, "/c", `${PSABS} -NoProfile -Command Start-Sleep -Seconds 40`]],
]

for (const [label, extra, argv] of cases) {
  const t0 = Date.now()
  const r = await runUnelevated(["run", "--name", containerName("d"), ...extra, "--", ...argv], 90_000)
  console.log(
    JSON.stringify({
      label,
      wallMs: Date.now() - t0,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      ok: r.ok,
      stage: r.stage ?? null,
      errorCode: r.errorCode ?? null,
      exitCode: r.exitCode,
      stdout: String(r.stdout ?? "").slice(0, 120),
      stderr: String(r.stderr ?? "").slice(0, 240),
    }),
  )
}
