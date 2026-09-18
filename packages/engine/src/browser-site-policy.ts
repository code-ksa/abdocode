import { readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

function workspaceDirectory(settingsFile: string): string {
  const profile = process.env["ABDO_DESKTOP_PROFILE"]
  if (profile === undefined) return dirname(settingsFile)
  if (!isAbsolute(profile) || profile.split(/[\\/]/u).includes("..")) throw Error("Invalid desktop profile")
  return profile
}

/** Desktop workspace metadata is the existing owner of site permissions. Read it
 * at each navigation, so an already connected surface obeys later changes. */
export function browserSiteAllowed(settingsFile: string, value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const file = join(workspaceDirectory(settingsFile), "workspace-v1.json")
    let metadata: ReturnType<typeof statSync>
    try { metadata = statSync(file) } catch (error) {
      // Only a genuinely absent desktop policy uses CLI defaults. Permission
      // errors and unreadable saved policies must not silently enable access.
      return process.env["ABDO_DESKTOP_PROFILE"] === undefined && (error as { code?: string }).code === "ENOENT"
    }
    if (!metadata.isFile() || metadata.size > 512 * 1024) return false
    const store = JSON.parse(readFileSync(file, "utf8"))
    if (!store || typeof store !== "object" || Array.isArray(store)) return false
    const preferences = store.preferences ?? {}
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return false
    const permission = preferences.browserDefaultPermission ?? "allow"
    const sites = preferences.blockedSites ?? []
    if (permission !== "allow" || !Array.isArray(sites) || sites.length > 200) return false
    const host = url.hostname.toLowerCase().replace(/\.$/u, "")
    return !sites.some((site: unknown) => {
      if (typeof site !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(site)) throw Error("Invalid site policy")
      const blocked = site.toLowerCase()
      return host === blocked || host.endsWith("." + blocked)
    })
  } catch { return false }
}

/** نطاقٌ كما تقبله القشرة (بلا بروتوكول ولا مسار) — الصيغةُ نفسُها التي يتحقّق بها الحفظُ في الإعدادات. */
export const SITE_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

export type SitePolicyRequest = { readonly ok: true; readonly op: "allow" | "block"; readonly site: string } | { readonly ok: false; readonly why: string }

/**
 * ن9 (09-16) — «browser allow <نطاق>» / «browser block <نطاق>» من المشغّل: المحرّكُ لا يكتب سياسةَ المواقع (مالكُها القشرة
 * `workspace.rs`)، بل يبثّ طلباً تحفظه القشرةُ بتحقّقها؛ هنا يُحكم الشكلُ فقط: نطاقٌ صريح، أو رابطٌ يُشتقّ مضيفُه.
 */
export const sitePolicyRequest = (verb: string, rest: string): SitePolicyRequest => {
  const op = verb === "allow" ? "allow" : verb === "block" ? "block" : undefined
  if (op === undefined) return { ok: false, why: "الصيغة: browser allow <نطاق> | browser block <نطاق>" }
  let site = rest.trim().toLowerCase().replace(/^["'«»]+|["'«»]+$/gu, "")
  if (/^https?:\/\//u.test(site)) { try { site = new URL(site).hostname } catch { site = "" } }
  site = site.replace(/\.$/u, "")
  if (site.length === 0 || site.length > 253 || !SITE_HOST.test(site)) return { ok: false, why: `نطاقٌ غيرُ صالح «${rest.trim().slice(0, 60)}» — اكتب اسمَ النطاق بلا بروتوكول ولا مسار (مثل example.com)` }
  return { ok: true, op, site }
}

/**
 * مقيس حيّاً 09-16 على المثبَّت 4.0.42: «browser block example.com» أعاد سطرَ الصيغة — لأنّ الفعلَ قُورن بالسطر كلِّه («block example.com»)
 * لا بكلمته الأولى، والمسمارُ النصّيّ في الاختبار مرّ فوق الخطأ. الفعلُ الكلمةُ الأولى وما بعدها النطاق؛ وغيرُ allow/block ليس من هذا الباب.
 */
export const sitePolicyCommand = (rest: string): SitePolicyRequest | undefined => {
  const words = rest.trim().split(/\s+/u)
  const verb = (words[0] ?? "").toLowerCase()
  if (verb !== "allow" && verb !== "block") return undefined
  return sitePolicyRequest(verb, words.slice(1).join(" "))
}

/** Desktop leases are minted by the native owner only after its Child is live
 * and owns the TCP listener. Endpoint UUID plus both process lifetimes prevents
 * stale leases granting authority over a different or personal browser. */
export function desktopBrowserOwnership(settingsFile: string, port: number): ((endpoint: string) => boolean) | undefined {
  const directory = dirname(settingsFile)
  try { statSync(join(workspaceDirectory(settingsFile), "workspace-v1.json")) } catch (error) {
    if (process.env["ABDO_DESKTOP_PROFILE"] !== undefined) return () => false
    if ((error as { code?: string }).code === "ENOENT") return undefined
  }
  return endpoint => {
    try {
      const file = join(directory, "browser-control-lease.json")
      if (statSync(file).size > 4096) return false
      const lease = JSON.parse(readFileSync(file, "utf8"))
      const url = new URL(endpoint)
      if (lease.version !== 1 || lease.port !== port || lease.endpoint !== endpoint || url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== port || !/^\/devtools\/browser\/[a-z0-9-]+$/iu.test(url.pathname) || url.search || url.hash) return false
      const owner = process.env["ABDO_DESKTOP_OWNER_PID"]
      if (owner && String(lease.ownerPid) !== owner) return false
      for (const pid of [lease.pid, lease.ownerPid]) {
        if (!Number.isSafeInteger(pid) || pid < 1) return false
        process.kill(pid, 0)
      }
      return true
    } catch { return false }
  }
}

/** Discover only a currently verified native lease, never a guessed CDP port. */
export function ownedDesktopBrowserPort(settingsFile: string): number | undefined {
  try {
    const file = join(dirname(settingsFile), "browser-control-lease.json")
    if (statSync(file).size > 4096) return undefined
    const lease = JSON.parse(readFileSync(file, "utf8"))
    if (!Number.isInteger(lease.port) || lease.port < 1024 || lease.port > 65535) return undefined
    return desktopBrowserOwnership(settingsFile, lease.port)?.(lease.endpoint) ? lease.port : undefined
  } catch { return undefined }
}
