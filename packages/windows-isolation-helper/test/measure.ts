/**
 * CL-16A2-C exploratory measurement. Not a test — it ASKS, it does not assert.
 * The assertions in `appcontainer.test.ts` are written from what this reports,
 * so they lock in measured reality instead of an expectation.
 *
 * KNOWN INVALID IN THIS ROUND, kept as the record of how it was caught: the
 * process-tree probes at the bottom use `ping -n 30` as the long-running
 * process. Inside an AppContainer `ping` cannot reach the IP driver and exits
 * IMMEDIATELY, so `timedOut: false` there means "nothing was running", not
 * "nothing was killed". `measure2.ts` re-ran them with `Start-Sleep`.
 *
 *   bun test/measure.ts
 */
import { containerName, helperBuilt, runDirect, runUnelevated, selfElevated } from "./harness"
import { join } from "node:path"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

if (!helperBuilt()) {
  console.log("helper not built; run build.ps1")
  process.exit(1)
}

const show = (label: string, r: Record<string, unknown>) => {
  const keys = ["elevated", "integrity", "ok", "exitCode", "timedOut", "stage", "errorCode", "error", "profileCreated", "profileDeleted", "assignedToJob", "isProcessInJob", "sid"]
  const brief = Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  console.log(`\n### ${label}`)
  console.log("   ", JSON.stringify(brief))
  if (typeof r.stdout === "string" && r.stdout.length) console.log("    stdout:", JSON.stringify(r.stdout.slice(0, 400)))
  if (typeof r.stderr === "string" && r.stderr.length) console.log("    stderr:", JSON.stringify(r.stderr.slice(0, 400)))
}

console.log(`self elevated: ${selfElevated()}`)
show("version (direct, elevated context)", runDirect(["version"]))
show("version (via de-elevation vehicle)", await runUnelevated(["version"]))
show("deelevate via linked token (expected to fail on this machine)", runDirect(["deelevate", "--", CMD, "/c", "echo", "x"]))

// ---- profile lifecycle
const n1 = containerName("life")
show("derive-sid without creating a profile", await runUnelevated(["derive-sid", "--name", n1]))
show("create-profile", await runUnelevated(["create-profile", "--name", n1]))
show("create-profile AGAIN (same name)", await runUnelevated(["create-profile", "--name", n1]))
show("delete-profile", await runUnelevated(["delete-profile", "--name", n1]))
show("delete-profile AGAIN (already gone)", await runUnelevated(["delete-profile", "--name", n1]))

// ---- does anything run at all?
const run = (tag: string, extra: string[], argv: string[]) =>
  runUnelevated(["run", "--name", containerName(tag), ...extra, "--", ...argv])

show("PLAIN control: cmd /c echo", await run("plain", ["--mode", "plain"], [CMD, "/c", "echo", "hello-plain"]))
show("APPCONTAINER: cmd /c echo", await run("ac", [], [CMD, "/c", "echo", "hello-ac"]))
show("APPCONTAINER with a DERIVED sid only (no profile)", await run("acd", ["--sid-source", "derive"], [CMD, "/c", "echo", "hello-derived"]))
show("APPCONTAINER: exit code and stderr", await run("acx", [], [CMD, "/c", "echo out& echo err 1>&2& exit /b 7"]))

// ---- filesystem, without touching a single ACL
show("APPCONTAINER: read cwd listing", await run("acfs", ["--cwd", "C:\\Windows"], [CMD, "/c", "dir", "/b", "C:\\Windows\\System32\\ntdll.dll"]))
show("APPCONTAINER: read a workspace file", await run("acfs2", [], [CMD, "/c", "type", join(import.meta.dir, "..", "package.json")]))
show("APPCONTAINER: write into TEMP", await run("acfs3", [], [CMD, "/c", "echo x > %TEMP%\\abdo-ac-probe.txt"]))
show("APPCONTAINER: write into the workspace", await run("acfs4", [], [CMD, "/c", `echo x > "${join(import.meta.dir, "..", "ac-probe.txt")}"`]))
show("APPCONTAINER: powershell starts?", await run("acps", [], [PS, "-NoProfile", "-Command", "Write-Output ok"]))

// ---- network, CONTROL FIRST
const TCP_PS = "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('8.8.8.8',53); 'TCP-OK' } catch { 'TCP-FAIL: '+$_.Exception.GetType().Name }"
const DNS_PS = "try { [Net.Dns]::GetHostEntry('example.com') | Out-Null; 'DNS-OK' } catch { 'DNS-FAIL: '+$_.Exception.GetType().Name }"
const HTTP_PS = "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://example.com).StatusCode; 'HTTP-OK' } catch { 'HTTP-FAIL: '+$_.Exception.GetType().Name }"
const LOOP_PS =
  "try { $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $l.Start(); $p=$l.LocalEndpoint.Port; $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',$p); $l.Stop(); 'LOOP-OK' } catch { 'LOOP-FAIL: '+$_.Exception.GetType().Name }"

for (const [label, script] of [["TCP", TCP_PS], ["DNS", DNS_PS], ["HTTP", HTTP_PS], ["LOOPBACK", LOOP_PS]] as const) {
  show(`CONTROL (plain) ${label}`, await run("net", ["--mode", "plain", "--timeout-ms", "40000"], [PS, "-NoProfile", "-Command", script]))
  show(`APPCONTAINER ${label}`, await run("net", ["--timeout-ms", "40000"], [PS, "-NoProfile", "-Command", script]))
}

// ---- process tree
show("APPCONTAINER: timeout kills", await run("tmo", ["--timeout-ms", "2000"], [CMD, "/c", "ping", "-n", "30", "127.0.0.1"]))
show(
  "APPCONTAINER: grandchild via start /b",
  await run("tree", ["--timeout-ms", "4000"], [CMD, "/c", "start /b cmd /c ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1"]),
)
show("NO-JOB: same thing without a job object", await run("nojob", ["--no-job", "--timeout-ms", "4000"], [CMD, "/c", "start /b cmd /c ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1"]))
