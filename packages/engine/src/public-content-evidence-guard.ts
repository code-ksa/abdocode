import type { ProjectIdentityWrite } from "./project-identity-guard"

const preciseContactPatterns = [
  /(?:مقر|عنوان)\s+(?:الشركة|المكتب)?\s*:/u,
  /(?:هاتف|جوال|واتساب|بريد\s+إلكتروني)\s*:/u,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u,
  /(?:\+?\d[\d\s()-]{7,}\d)/u,
  /©\s*(?:19|20)\d{2}/u,
] as const

/** Fresh public pages may invite contact, but cannot invent exact coordinates. */
export function unsupportedPublicContactClaim(input: ProjectIdentityWrite): string | undefined {
  if (input.operation !== "write" || !/^app\/.*\.[jt]sx$/iu.test(input.normalizedTarget)) return undefined
  const strings = input.after.match(/[^\r\n]{0,160}/gu) ?? []
  const claim = strings.find((line) => preciseContactPatterns.some((pattern) => pattern.test(line)))?.trim()
  return claim && claim.length > 0 ? claim.slice(0, 160) : undefined
}
