/**
 * CL-16A3-B1 §1 — the Windows-side collector for the profile inventory.
 *
 * READ-ONLY BY CONSTRUCTION. It runs one PowerShell probe with a FIXED script
 * (no interpolated input) and only ever reads: `%USERPROFILE%`, the system's
 * `ProfileList`, the current user's Known Folder redirections, and the OneDrive
 * environment roots. It performs no registry write, creates nothing, and grants
 * nothing — the measurement phase of this slice is explicitly not allowed to
 * mutate ACLs.
 *
 * Every source can fail independently, and a failure is REPORTED rather than
 * swallowed, because `buildProfileInventory` turns a missing required source
 * into `profile_inventory_unknown` instead of an empty (and therefore
 * dangerously permissive) list.
 */
import { lstatSync, realpathSync, statSync } from "node:fs"
import { buildProfileInventory, type ProfileRootInventory, type RawProfileSources, type ResolveInfo } from "./profile-inventory"

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

/** A fixed script. No caller input reaches it, so nothing can be injected. */
const PROBE = `
$ErrorActionPreference = 'Continue'
$out = [ordered]@{ userProfile = $env:USERPROFILE; profileList = @(); knownFolders = @{}; oneDrive = @(); errors = @() }
try {
  $out.profileList = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' -ErrorAction Stop |
    ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ProfileImagePath } |
    Where-Object { $_ })
} catch { $out.errors += 'profileList:' + $_.Exception.GetType().Name }
try {
  $k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -ErrorAction Stop
  $h = @{}
  $k.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $h[$_.Name] = [string]$_.Value }
  $out.knownFolders = $h
} catch { $out.errors += 'knownFolders:' + $_.Exception.GetType().Name }
foreach ($v in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) { if ($v) { $out.oneDrive += $v } }
$out | ConvertTo-Json -Depth 4 -Compress
`

/** Expand `%VAR%` in a Known Folder value, using only the current environment. */
function expandEnv(v: string): string {
  return v.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
}

export function collectWindowsProfileSources(): RawProfileSources {
  if (process.platform !== "win32") return { errors: ["platform_not_windows"] }
  // [CL-00A:ALLOW windows_profile_inventory_probe]
  const p = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", PROBE], { stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  let parsed: { userProfile?: string; profileList?: string[]; knownFolders?: Record<string, string>; oneDrive?: string[]; errors?: string[] }
  try {
    parsed = JSON.parse(p.stdout.toString().trim())
  } catch {
    return { errors: ["probe_unreadable"] }
  }
  const knownFolders: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed.knownFolders ?? {})) if (typeof v === "string") knownFolders[k] = expandEnv(v)
  return {
    ...(parsed.userProfile ? { userProfile: parsed.userProfile } : {}),
    ...(Array.isArray(parsed.profileList) ? { profileListPaths: parsed.profileList } : {}),
    knownFolders,
    oneDriveRoots: parsed.oneDrive ?? [],
    errors: parsed.errors ?? [],
  }
}

/** Final path + identity + reparse flag, for one path. Read-only. */
export function resolvePathInfo(path: string): ResolveInfo {
  const info: { resolved?: string; identity?: string; reparse?: boolean } = {}
  try {
    info.reparse = lstatSync(path).isSymbolicLink()
  } catch {
    /* recorded by the caller as an unresolved root */
  }
  try {
    info.resolved = realpathSync(path)
  } catch {
    /* leave unresolved */
  }
  try {
    const s = statSync(path)
    info.identity = `${s.dev}:${s.ino}`
  } catch {
    /* leave unidentified */
  }
  return info
}

export function collectWindowsProfileInventory(): ProfileRootInventory {
  return buildProfileInventory(collectWindowsProfileSources(), resolvePathInfo)
}
