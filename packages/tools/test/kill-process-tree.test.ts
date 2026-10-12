/**
 * 2026-10-08 (measured): 31 orphaned `docker.exe` after `run docker info` timeouts — the direct child was killed before
 * `taskkill /T` could walk to its children. Here a real tree (powershell → powershell sleeping) is killed and the
 * grandchild must be gone too.
 */
import { expect, test } from "bun:test"
import { killProcessTree } from "../src/launcher"

const alive = (pid: number): boolean => {
  const r = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], { stdout: "pipe", stderr: "ignore" })
  return r.stdout.toString().includes(String(pid))
}

test.skipIf(process.platform !== "win32")("killProcessTree takes the grandchildren on Windows, not only the direct child", async () => {
  const marker = `abdo-killtree-${Date.now()}`
  const parent = Bun.spawn(["powershell", "-NoProfile", "-Command", `Start-Process -NoNewWindow -FilePath powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 120 # ${marker}'; Start-Sleep 120`], { stdout: "ignore", stderr: "ignore" })
  let child: number | undefined
  for (let i = 0; i < 60 && child === undefined; i += 1) {
    await Bun.sleep(250)
    const q = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne ${parent.pid} -and $_.Name -eq 'powershell.exe' -and $_.ParentProcessId -eq ${parent.pid} }).ProcessId`], { stdout: "pipe" })
    const pid = Number.parseInt(q.stdout.toString().trim(), 10)
    if (Number.isInteger(pid) && pid > 0) child = pid
  }
  expect(child).toBeDefined()
  killProcessTree(parent)
  await Bun.sleep(1500)
  expect(alive(parent.pid)).toBe(false)
  expect(alive(child!)).toBe(false)
}, 60_000)
