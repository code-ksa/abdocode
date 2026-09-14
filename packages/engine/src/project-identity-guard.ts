import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const layoutCandidates = ["app/layout.tsx", "app/layout.jsx", "app/layout.ts", "app/layout.js"] as const
const domainStopWords = new Set([
  "موقع", "عربي", "تعريفي", "خدمات", "خدمة", "إدارة", "المشروع", "المشاريع", "الشركة",
  "site", "website", "company", "services", "service", "project", "projects", "management", "official",
])

/**
 * Derive the customer's visible project identity from their existing metadata.
 * This is host evidence, not a model-supplied label. The prefix before a common
 * title separator is the stable brand anchor (for example "Company | Home").
 */
export function readProjectIdentityAnchor(projectDir: string): string | undefined {
  for (const candidate of layoutCandidates) {
    const path = join(projectDir, candidate)
    if (!existsSync(path)) continue
    const source = readFileSync(path, "utf-8")
    const title = source.match(/\btitle\s*:\s*["'`]([^"'`]+)["'`]/u)?.[1]?.trim()
    const anchor = title?.split(/\s*(?:\||—|–)\s*/u, 1)[0]?.trim()
    if (anchor !== undefined && anchor.length >= 2) return anchor
  }
  return undefined
}

/** Distinctive terms from the customer's own metadata description. */
export function readProjectDomainAnchors(projectDir: string): string[] {
  for (const candidate of layoutCandidates) {
    const path = join(projectDir, candidate)
    if (!existsSync(path)) continue
    const source = readFileSync(path, "utf-8")
    const description = source.match(/\bdescription\s*:\s*["'`]([^"'`]+)["'`]/u)?.[1] ?? ""
    const words = description.match(/[\p{L}\p{N}]+/gu) ?? []
    const anchors = words
      .map((word) => {
        let normalized = word.replace(/^و(?=[\p{L}\p{N}]{4,}$)/u, "").toLocaleLowerCase()
        if (normalized.startsWith("ل") && domainStopWords.has(normalized.slice(1))) normalized = normalized.slice(1)
        return normalized
      })
      .filter((word) => word.length >= 4 && !domainStopWords.has(word))
    if (anchors.length > 0) return [...new Set(anchors)].slice(0, 8)
  }
  return []
}

export type ProjectIdentityWrite = {
  projectDir: string
  normalizedTarget: string
  operation: "write" | "edit"
  before: string
  after: string
}

/**
 * A fresh project has no page metadata yet, so its directory name is the only
 * host-owned identity evidence. Harness directories append `-agent-N-*`; the
 * customer slug before that suffix must remain the package-name prefix.
 */
export function packageIdentityViolation(input: ProjectIdentityWrite): string | undefined {
  if (input.operation !== "write" || input.normalizedTarget !== "package.json") return undefined
  const expected = basename(input.projectDir).toLocaleLowerCase().replace(/-agent-\d+(?:-[a-z0-9-]+)*$/u, "")
  if (expected.length < 2) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(input.after) } catch { return undefined }
  const rawName = typeof parsed === "object" && parsed !== null && "name" in parsed
    ? (parsed as { name?: unknown }).name
    : undefined
  if (typeof rawName !== "string") return undefined
  const actual = rawName.toLocaleLowerCase().split("/").at(-1) ?? ""
  return actual === expected || actual.startsWith(`${expected}-`) ? undefined : expected
}

/**
 * Full-file replacement is the dangerous path used by small models when an
 * incremental request drifts into a different product. Literal edits remain
 * available for an explicitly requested rename, while a full page overwrite
 * may not silently erase an identity that the old page and layout agree on.
 */
export function projectIdentityViolation(input: ProjectIdentityWrite): string | undefined {
  if (input.operation !== "write" || !/^app\/.*\.[jt]sx$/iu.test(input.normalizedTarget) || input.before.length === 0) return undefined
  const anchor = readProjectIdentityAnchor(input.projectDir)
  if (anchor === undefined || !input.before.includes(anchor) || input.after.includes(anchor)) return undefined
  return anchor
}

/**
 * Seed and fixture files are unusually high-leverage: invented demo records
 * can silently turn a customer's product into another domain while keeping
 * the brand name. Content-heavy seed writes must therefore carry at least one
 * distinctive domain term from the existing metadata description.
 */
export function projectDomainViolation(input: ProjectIdentityWrite): string[] | undefined {
  if (input.operation !== "write" || !/(?:^|\/)(?:[^/]*(?:seed|fixture|sample)[^/]*)\.[cm]?[jt]sx?$/iu.test(input.normalizedTarget)) return undefined
  const contentStrings = input.after.match(/["'`][^"'`\r\n]*[\p{L}][^"'`\r\n]*["'`]/gu) ?? []
  if (contentStrings.length < 3) return undefined
  const anchors = readProjectDomainAnchors(input.projectDir)
  if (anchors.length === 0 || anchors.some((anchor) => input.after.toLocaleLowerCase().includes(anchor))) return undefined
  return anchors
}

const apiRouteFamilies = [
  ["contact", "contacts", "inquiry", "inquiries", "message", "messages"],
  ["service", "services", "offering", "offerings"],
  ["project", "projects", "portfolio"],
] as const

/** Refuse a second API door for a domain already owned by an existing route. */
export function parallelApiRouteViolation(input: ProjectIdentityWrite): string | undefined {
  if (input.operation !== "write" || input.before.length > 0) return undefined
  const match = input.normalizedTarget.match(/^app\/api\/([^/]+)\/route\.[jt]s$/iu)
  const proposed = match?.[1]?.toLocaleLowerCase()
  if (!proposed) return undefined
  const family = apiRouteFamilies.find((names) => names.includes(proposed as never))
  if (!family) return undefined
  for (const existing of family) {
    if (existing === proposed) continue
    for (const extension of ["ts", "js"] as const) {
      if (existsSync(join(input.projectDir, "app", "api", existing, `route.${extension}`))) return existing
    }
  }
  return undefined
}
