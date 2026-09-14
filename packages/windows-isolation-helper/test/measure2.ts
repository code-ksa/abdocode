/**
 * CL-16A2-C exploratory measurement, round 2.
 *
 * Round 1 used `ping -n 30` as the long-running process. Inside an AppContainer
 * `ping` cannot reach the IP driver and exits IMMEDIATELY with "General
 * failure", so every process-tree result it produced was vacuous — `timedOut`
 * was false because nothing was still running to time out. Round 2 uses
 * `Start-Sleep`, which needs no network.
 *
 *   bun test/measure2.ts
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { containerName, runDirect, runUnelevated } from "./harness"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

const show = (label: string, r: Record<string, unknown>) => {
  const keys = ["elevated", "integrity", "ok", "exitCode", "timedOut", "stage", "errorCode", "error", "hresult", "profileCreated", "profileExisted", "profileDeleted", "profileDeleteHresult", "assignedToJob", "isProcessInJob", "durationMs"]
  console.log(`\n### ${label}`)
  console.log("   ", JSON.stringify(Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))))
  if (typeof r.stdout === "string" && r.stdout.length) console.log("    stdout:", JSON.stringify(r.stdout.slice(0, 300)))
  if (typeof r.stderr === "string" && r.stderr.length) console.log("    stderr:", JSON.stringify(r.stderr.slice(0, 300)))
}
const run = (tag: string, extra: string[], argv: string[]) => runUnelevated(["run", "--name", containerName(tag), ...extra, "--", ...argv])

// ---------------------------------------------------------------- 1. the tree
const SLEEP = (s: number) => [PS, "-NoProfile", "-Command", `Start-Sleep -Seconds ${s}`]

show("timeout kills a real sleeper (AppContainer)", await run("t1", ["--timeout-ms", "2500"], SLEEP(40)))
show(
  "grandchild: parent sleeps, child sleeps in a NEW process",
  await run("t2", ["--timeout-ms", "3000"], [PS, "-NoProfile", "-Command", "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -WindowStyle Hidden; Start-Sleep -Seconds 40"]),
)
show(
  "detach attempt: cmd start /b then sleep",
  await run("t3", ["--timeout-ms", "3000"], [CMD, "/c", "start /b powershell -NoProfile -Command Start-Sleep -Seconds 40 & powershell -NoProfile -Command Start-Sleep -Seconds 40"]),
)
show("NO-JOB control: same detach attempt without a job", await run("t4", ["--no-job", "--timeout-ms", "3000"], [CMD, "/c", "start /b powershell -NoProfile -Command Start-Sleep -Seconds 40 & powershell -NoProfile -Command Start-Sleep -Seconds 40"]))
show("large output is capped, not deadlocked", await run("t5", ["--timeout-ms", "60000"], [PS, "-NoProfile", "-Command", "1..40000 | ForEach-Object { 'x' * 60 }"]))

// ------------------------------------------------------- 2. network, children
const NET = (script: string) => [PS, "-NoProfile", "-Command", script]
const TCP = "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('8.8.8.8',53); 'TCP-OK' } catch { 'TCP-FAIL' }"
const UDP =
  "try { $u=New-Object Net.Sockets.UdpClient; $u.Client.ReceiveTimeout=4000; $u.Connect('8.8.8.8',53); [void]$u.Send([byte[]](0,0,1,0,0,1,0,0,0,0,0,0,0,0,1,0,1),17); $r=$u.Receive([ref]$null); 'UDP-OK' } catch { 'UDP-FAIL' }"
const CHILD_TCP = `powershell -NoProfile -Command "${TCP.replace(/"/g, "'")}"`

for (const [label, script] of [["UDP", UDP]] as const) {
  show(`CONTROL (plain) ${label}`, await run("n", ["--mode", "plain", "--timeout-ms", "40000"], NET(script)))
  show(`APPCONTAINER ${label}`, await run("n", ["--timeout-ms", "40000"], NET(script)))
}
show("CONTROL (plain) TCP from a GRANDCHILD", await run("n", ["--mode", "plain", "--timeout-ms", "40000"], [CMD, "/c", CHILD_TCP]))
show("APPCONTAINER TCP from a GRANDCHILD", await run("n", ["--timeout-ms", "40000"], [CMD, "/c", CHILD_TCP]))
show(
  "APPCONTAINER TCP after PATH manipulation",
  await run("n", ["--timeout-ms", "40000"], [CMD, "/c", `set PATH=C:\\Windows\\System32;%PATH% & ${CHILD_TCP}`]),
)
show("APPCONTAINER: curl.exe", await run("n", ["--timeout-ms", "40000"], ["C:\\Windows\\System32\\curl.exe", "-sS", "-m", "8", "http://example.com"]))
show("CONTROL (plain): curl.exe", await run("n", ["--mode", "plain", "--timeout-ms", "40000"], ["C:\\Windows\\System32\\curl.exe", "-sS", "-m", "8", "-o", "NUL", "http://example.com"]))

// Loopback to a listener in ANOTHER process (round 1 only proved same-process).
const LOOP_OTHER =
  "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $l.Start(); $p=$l.LocalEndpoint.Port; " +
  "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',\"try{ (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',$p); 'CHILD-LOOP-OK' } catch { 'CHILD-LOOP-FAIL' }\" -NoNewWindow -Wait; $l.Stop()"
show("CONTROL (plain) loopback ACROSS processes", await run("l", ["--mode", "plain", "--timeout-ms", "40000"], NET(LOOP_OTHER)))
show("APPCONTAINER loopback ACROSS processes", await run("l", ["--timeout-ms", "40000"], NET(LOOP_OTHER)))

// ------------------------------------------------------- 3. persistent state
const name = containerName("state")
const r1 = await runUnelevated(["create-profile", "--name", name])
show("create a profile and LOOK for what it left behind", r1)
const pkgRoot = join(process.env.LOCALAPPDATA ?? "", "Packages")
const dirBefore = existsSync(join(pkgRoot, name))
console.log(`    %LOCALAPPDATA%\\Packages\\${name} exists: ${dirBefore}`)
const reg = runDirect(["version"]) // no-op; registry read below via reg.exe
const regQ = Bun.spawnSync(
  ["C:\\Windows\\System32\\reg.exe", "query", `HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\${r1.sid}`],
  { stdout: "pipe", stderr: "pipe" },
)
console.log(`    registry mapping present: ${regQ.exitCode === 0}`)
console.log(`    ${regQ.stdout.toString().trim().split("\n").slice(0, 3).join(" | ")}`)
const del = await runUnelevated(["delete-profile", "--name", name])
show("delete it", del)
console.log(`    %LOCALAPPDATA%\\Packages\\${name} still exists after delete: ${existsSync(join(pkgRoot, name))}`)
const regQ2 = Bun.spawnSync(
  ["C:\\Windows\\System32\\reg.exe", "query", `HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\${r1.sid}`],
  { stdout: "pipe", stderr: "pipe" },
)
console.log(`    registry mapping still present after delete: ${regQ2.exitCode === 0}`)
void reg

// --------------------------------------------------------- 4. parallel runs
const par = await Promise.all([
  run("p1", ["--timeout-ms", "30000"], [CMD, "/c", "echo", "A"]),
  run("p2", ["--timeout-ms", "30000"], [CMD, "/c", "echo", "B"]),
  run("p3", ["--timeout-ms", "30000"], [CMD, "/c", "echo", "C"]),
])
par.forEach((r, i) => show(`parallel run ${i + 1}`, r))

// SAME name, two runs at once — the collision case.
const shared = containerName("shared")
const both = await Promise.all([
  runUnelevated(["run", "--name", shared, "--timeout-ms", "30000", "--", CMD, "/c", "echo", "first"]),
  runUnelevated(["run", "--name", shared, "--timeout-ms", "30000", "--", CMD, "/c", "echo", "second"]),
])
both.forEach((r, i) => show(`SAME-NAME concurrent run ${i + 1}`, r))
await runUnelevated(["delete-profile", "--name", shared])

// ------------------------------------------------------------ 5. leftovers
const leftovers = existsSync(pkgRoot) ? readdirSync(pkgRoot).filter((d) => d.startsWith("abdo-")) : []
console.log(`\n### leftover abdo-* package dirs: ${leftovers.length}`)
console.log("   ", leftovers.slice(0, 20).join(", ") || "(none)")
