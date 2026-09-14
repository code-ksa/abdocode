import type { ProjectIdentityWrite } from "./project-identity-guard"

/** App Router layouts own the document shell; pages render inside body. */
export function nextAppPageShellViolation(input: ProjectIdentityWrite): string[] | undefined {
  if (input.operation !== "write" || !/^app\/.*\.[jt]sx$/iu.test(input.normalizedTarget) || /^app\/layout\.[jt]sx$/iu.test(input.normalizedTarget)) return undefined
  const forbidden = ["html", "head", "body"].filter((tag) => new RegExp(`<${tag}\\b`, "iu").test(input.after))
  if (/rel=["']stylesheet["'][^>]*href=["']\/globals\.css["']/iu.test(input.after)) forbidden.push("رابط globals.css")
  return forbidden.length > 0 ? forbidden : undefined
}
