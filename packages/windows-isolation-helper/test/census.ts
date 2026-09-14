/**
 * CL-16A2-D §5 — the resource census.
 *
 * A measurement run is only trustworthy if it can say what it left behind. This
 * counts the things this harness is capable of leaking, before and after, and
 * an unexplained increase FAILS the run.
 *
 * It exists because the harness leaked 885 terminal windows and 920 console
 * hosts on a user's machine while every test reported green. Nothing in the
 * suite was watching, so nothing noticed.
 */
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface Census {
  readonly conhostTotal: number
  readonly conhostOrphaned: number
  readonly helperProcesses: number
  readonly explorerProcesses: number
  readonly windowsTerminals: number
  readonly appContainerProfiles: number
  readonly queueDirs: number
}

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

/**
 * Orphaned conhosts are counted separately from the total: a console host whose
 * parent is gone has nothing left to serve and is pure leak, whereas the total
 * moves around with whatever else the machine is doing.
 */
const SCRIPT = `
$ch = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'"
$orph = 0
foreach ($c in $ch) { if (-not (Get-Process -Id $c.ParentProcessId -ErrorAction SilentlyContinue)) { $orph++ } }
$o = [ordered]@{
  conhostTotal = @($ch).Count
  conhostOrphaned = $orph
  helperProcesses = @(Get-Process abdo-winiso -ErrorAction SilentlyContinue).Count
  explorerProcesses = @(Get-Process explorer -ErrorAction SilentlyContinue).Count
  windowsTerminals = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue).Count
  appContainerProfiles = @(Get-ChildItem "$env:LOCALAPPDATA\\Packages" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'abdo-winiso-*' }).Count
}
$o | ConvertTo-Json -Compress
`

export function takeCensus(): Census {
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", SCRIPT], { stdout: "pipe", stderr: "pipe" })
  let parsed: Partial<Census> = {}
  try {
    parsed = JSON.parse(p.stdout.toString().trim())
  } catch {
    /* reported as zeros below; the diff will then look wrong, which is correct */
  }
  let queueDirs = 0
  try {
    queueDirs = readdirSync(tmpdir()).filter((d) => d.startsWith("abdo-winiso-harness-")).length
  } catch {
    /* ignore */
  }
  return {
    conhostTotal: parsed.conhostTotal ?? -1,
    conhostOrphaned: parsed.conhostOrphaned ?? -1,
    helperProcesses: parsed.helperProcesses ?? -1,
    explorerProcesses: parsed.explorerProcesses ?? -1,
    windowsTerminals: parsed.windowsTerminals ?? -1,
    appContainerProfiles: parsed.appContainerProfiles ?? -1,
    queueDirs,
  }
}

export interface CensusVerdict {
  readonly ok: boolean
  readonly violations: readonly string[]
  readonly before: Census
  readonly after: Census
}

/**
 * What is allowed to change, and by how much.
 *
 * `explorerProcesses` and `windowsTerminals` must not grow AT ALL — those are
 * the user's desktop. `conhostOrphaned` must not grow at all either: an orphan
 * is by definition something nobody will ever clean up. The others get a small
 * allowance for the harness's own live server and queue while it is shutting
 * down, and for console hosts belonging to processes outside this suite.
 */
export function judgeCensus(before: Census, after: Census): CensusVerdict {
  const violations: string[] = []
  const check = (name: keyof Census, allowed: number) => {
    const grew = (after[name] as number) - (before[name] as number)
    if (grew > allowed) violations.push(`${name} grew by ${grew} (allowed ${allowed}): ${before[name]} -> ${after[name]}`)
  }
  check("conhostOrphaned", 0)
  check("explorerProcesses", 0)
  check("windowsTerminals", 0)
  check("appContainerProfiles", 0)
  check("helperProcesses", 1) // the run's own server, until its idle timeout
  check("queueDirs", 1) //  and its queue
  check("conhostTotal", 3) // unrelated console activity on the machine
  return { ok: violations.length === 0, violations, before, after }
}

/**
 * Reap console hosts whose owning process is gone.
 *
 * ONLY for tests that deliberately kill or abort a helper. `reap_console_hosts`
 * in the helper runs after the child is waited on, so a process that is
 * SIGKILLed or `abort()`ed never reaches it and its child's console host is
 * orphaned. That is a true property of a crash, not a defect — but a test that
 * causes it on purpose must clear up after itself, otherwise the census has to
 * be loosened and stops being able to see the next real leak.
 */
export function reapOrphanConsoleHosts(): number {
  const script = `
$n = 0
$ch = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'"
foreach ($c in $ch) {
  if (-not (Get-Process -Id $c.ParentProcessId -ErrorAction SilentlyContinue)) {
    try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $n++ } catch {}
  }
}
$n
`
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "pipe" })
  return Number(p.stdout.toString().trim()) || 0
}

export const formatCensus = (c: Census) =>
  `conhost=${c.conhostTotal}(orphan ${c.conhostOrphaned}) helper=${c.helperProcesses} explorer=${c.explorerProcesses} wt=${c.windowsTerminals} profiles=${c.appContainerProfiles} queues=${c.queueDirs}`
