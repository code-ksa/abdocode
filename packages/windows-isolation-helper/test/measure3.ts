/**
 * CL-16A2-C exploratory measurement, round 3.
 *
 * Round 2's grandchild canary was INVALID: `cmd /c powershell -Command "...$c..."`
 * lost the `$` variables, so the child printed the script text instead of
 * running it. The CONTROL printed the same garbage, which is the only reason it
 * was caught — a canary that does not run reads as "blocked" if you only look at
 * the isolated side. Round 3 uses `Start-Process ... -Wait`, which round 2
 * proved carries a script through intact.
 *
 *   bun test/measure3.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HELPER, containerName, runUnelevated } from "./harness"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const pkgRoot = join(process.env.LOCALAPPDATA ?? "", "Packages")

const show = (label: string, r: Record<string, unknown>) => {
  const keys = ["elevated", "integrity", "ok", "exitCode", "timedOut", "stage", "errorCode", "error", "profileCreated", "profileExisted", "profileDeleted", "profileDeleteHresult", "durationMs"]
  console.log(`\n### ${label}`)
  console.log("   ", JSON.stringify(Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))))
  if (typeof r.stdout === "string" && r.stdout.length) console.log("    stdout:", JSON.stringify(r.stdout.slice(0, 300)))
  if (typeof r.stderr === "string" && r.stderr.length) console.log("    stderr:", JSON.stringify(r.stderr.slice(0, 300)))
}
const run = (tag: string, extra: string[], argv: string[]) => runUnelevated(["run", "--name", containerName(tag), ...extra, "--", ...argv])

/** A grandchild that runs `inner` in a NEW process and reports its own verdict. */
const grandchild = (inner: string) => [
  PS,
  "-NoProfile",
  "-Command",
  `Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',"${inner}" -NoNewWindow -Wait`,
]
const TCP_INNER = "try{ (New-Object Net.Sockets.TcpClient).Connect('8.8.8.8',53); 'GC-TCP-OK' } catch { 'GC-TCP-FAIL' }"
const DNS_INNER = "try{ [Net.Dns]::GetHostEntry('example.com') | Out-Null; 'GC-DNS-OK' } catch { 'GC-DNS-FAIL' }"

console.log("=== 1. grandchild egress, control first ===")
for (const [label, inner] of [["TCP", TCP_INNER], ["DNS", DNS_INNER]] as const) {
  show(`CONTROL (plain) grandchild ${label}`, await run("g", ["--mode", "plain", "--timeout-ms", "40000"], grandchild(inner)))
  show(`APPCONTAINER grandchild ${label}`, await run("g", ["--timeout-ms", "40000"], grandchild(inner)))
}

console.log("\n=== 2. loopback OUT of the container (the security-relevant direction) ===")
// A listener OUTSIDE any AppContainer, in this harness process. If a sandboxed
// run can reach it, then a local dev server / the Abdo API on 127.0.0.1 is
// reachable from inside `deny_all`, which is a real exposure and must be stated.
const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {}, open(s) { s.write("HELLO-FROM-OUTSIDE"); s.end() } },
})
const port = server.port
console.log(`    outside listener on 127.0.0.1:${port}`)
const REACH = `try{ (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',${port}); 'OUTSIDE-LOOPBACK-REACHED' } catch { 'OUTSIDE-LOOPBACK-BLOCKED' }`
show("CONTROL (plain) -> outside loopback listener", await run("lo", ["--mode", "plain", "--timeout-ms", "30000"], [PS, "-NoProfile", "-Command", REACH]))
show("APPCONTAINER -> outside loopback listener", await run("lo", ["--timeout-ms", "30000"], [PS, "-NoProfile", "-Command", REACH]))
server.stop(true)

console.log("\n=== 3. OVERLAPPING runs that share a container name ===")
const shared = containerName("race")
const overlapping = await Promise.all([
  runUnelevated(["run", "--name", shared, "--timeout-ms", "30000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 6; 'A-DONE'"]),
  (async () => {
    await Bun.sleep(1500) // start well inside the first run's lifetime
    return runUnelevated(["run", "--name", shared, "--timeout-ms", "30000", "--", CMD, "/c", "echo B-DONE"])
  })(),
])
overlapping.forEach((r, i) => show(`overlapping run ${i + 1} (same name)`, r))
console.log(`    profile dir left behind: ${existsSync(join(pkgRoot, shared))}`)
await runUnelevated(["delete-profile", "--name", shared])

console.log("\n=== 4. CRASH: the helper is killed mid-run ===")
// NOTE ON CONTEXT: this one runs the helper DIRECTLY, so it inherits this
// shell's elevated token. What it measures — whether a killed helper orphans a
// profile and whether KILL_ON_JOB_CLOSE reaps the child — is a process-lifetime
// property, not a privilege one. It is labelled rather than quietly mixed in
// with the no-admin results.
const crashName = containerName("crash")
const marker = join(tmpdir(), `abdo-crash-marker-${Date.now()}.txt`)
const child = Bun.spawn(
  [HELPER, "run", "--name", crashName, "--timeout-ms", "60000", "--", PS, "-NoProfile", "-Command", `Start-Sleep -Seconds 8; Set-Content -Path '${marker}' -Value survived`],
  { stdout: "pipe", stderr: "pipe" },
)
await Bun.sleep(2000)
child.kill(9)
await child.exited
console.log(`    helper killed. profile dir orphaned: ${existsSync(join(pkgRoot, crashName))}`)
await Bun.sleep(9000)
console.log(`    child survived the helper's death (marker written): ${existsSync(marker)}`)
rmSync(marker, { force: true })
const cleanup = await runUnelevated(["delete-profile", "--name", crashName])
console.log(`    orphan cleanup by name: ok=${cleanup.ok} hresult=${cleanup.hresult}`)
console.log(`    profile dir after cleanup: ${existsSync(join(pkgRoot, crashName))}`)

console.log("\n=== 5. can a NON-ELEVATED user grant the container SID access to a dir? ===")
const scratch = mkdtempSync(join(tmpdir(), "abdo-acl-"))
writeFileSync(join(scratch, "readme.txt"), "workspace-content", "utf8")
const aclName = containerName("acl")
const created = await runUnelevated(["create-profile", "--name", aclName])
const sid = String(created.sid ?? "")
console.log(`    scratch: ${scratch}`)
console.log(`    container sid: ${sid}`)
const before = Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", scratch], { stdout: "pipe", stderr: "pipe" })
console.log(`    ACL before:\n${before.stdout.toString().trim().split("\n").map((l) => "      " + l).join("\n")}`)
show("read the scratch file BEFORE any grant", await runUnelevated(["run", "--name", aclName, "--timeout-ms", "20000", "--", CMD, "/c", "type", join(scratch, "readme.txt")]))
const grant = Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", scratch, "/grant", `*${sid}:(OI)(CI)(RX)`, "/T"], { stdout: "pipe", stderr: "pipe" })
console.log(`    icacls grant exit=${grant.exitCode}: ${grant.stdout.toString().trim().slice(0, 200)} ${grant.stderr.toString().trim().slice(0, 200)}`)
show("read the scratch file AFTER the grant", await runUnelevated(["run", "--name", aclName, "--timeout-ms", "20000", "--", CMD, "/c", "type", join(scratch, "readme.txt")]))
const revoke = Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", scratch, "/remove:g", `*${sid}`, "/T"], { stdout: "pipe", stderr: "pipe" })
console.log(`    icacls revoke exit=${revoke.exitCode}`)
const after = Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", scratch], { stdout: "pipe", stderr: "pipe" })
console.log(`    ACL restored identical: ${after.stdout.toString().trim() === before.stdout.toString().trim()}`)
show("read the scratch file AFTER the revoke", await runUnelevated(["run", "--name", aclName, "--timeout-ms", "20000", "--", CMD, "/c", "type", join(scratch, "readme.txt")]))
await runUnelevated(["delete-profile", "--name", aclName])
rmSync(scratch, { recursive: true, force: true })
