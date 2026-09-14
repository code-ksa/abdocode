import type { ToolVerdict } from "@abdo/engine-host"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { exitZero } from "./failure-tiering"

const nextEntryCandidates = [
  "app/page.tsx", "app/page.jsx", "app/page.ts", "app/page.js",
  "src/app/page.tsx", "src/app/page.jsx", "src/app/page.ts", "src/app/page.js",
  "pages/index.tsx", "pages/index.jsx", "pages/index.ts", "pages/index.js",
  "src/pages/index.tsx", "src/pages/index.jsx", "src/pages/index.ts", "src/pages/index.js",
] as const

const isNextProject = (projectDir: string): boolean => {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return manifest.dependencies?.next !== undefined || manifest.devDependencies?.next !== undefined
  } catch { return false }
}

/** A zero-exit Next build that only emits /404 is not a customer website. */
export function projectBuildViolation(projectDir: string, output: string, verdict?: ToolVerdict): string | undefined {
  if (!exitZero(output, verdict) || !isNextProject(projectDir)) return undefined
  if (nextEntryCandidates.some((candidate) => existsSync(join(projectDir, candidate)))) return undefined
  return "بناء Next.js خرج 0 لكنه لا يملك صفحة رئيسية app/page أو pages/index؛ خرج البناء صفحة 404 فقط ولا يمثل موقعاً قابلاً للتسليم"
}
