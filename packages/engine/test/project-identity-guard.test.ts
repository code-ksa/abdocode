import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { packageIdentityViolation, parallelApiRouteViolation, projectDomainViolation, projectIdentityViolation, readProjectDomainAnchors, readProjectIdentityAnchor } from "../src/project-identity-guard"

const roots: string[] = []
const fixture = (title = "مقاولات السعادة | نبني بثقة") => {
  const root = join(import.meta.dir, `.identity-fixture-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(join(root, "app"), { recursive: true })
  writeFileSync(join(root, "app", "layout.tsx"), `export const metadata = { title: "${title}" }`)
  return root
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("project identity guard", () => {
  test("derives the customer brand anchor from existing metadata", () => {
    expect(readProjectIdentityAnchor(fixture())).toBe("مقاولات السعادة")
  })

  test("preserves the customer slug when a fresh harness project writes package metadata", () => {
    const projectDir = join(import.meta.dir, "al-saada-contracting-agent-7-cms")
    const base = { projectDir, normalizedTarget: "package.json", operation: "write" as const, before: "" }
    expect(packageIdentityViolation({ ...base, after: '{"name":"alsahaba-contracting"}' })).toBe("al-saada-contracting")
    expect(packageIdentityViolation({ ...base, after: '{"name":"al-saada-contracting"}' })).toBeUndefined()
    expect(packageIdentityViolation({ ...base, after: '{"name":"@abdo/al-saada-contracting-web"}' })).toBeUndefined()
  })

  test("rejects a full home-page overwrite that silently removes the existing brand", () => {
    const projectDir = fixture()
    expect(projectIdentityViolation({
      projectDir,
      normalizedTarget: "app/page.tsx",
      operation: "write",
      before: "export default () => <h1>مقاولات السعادة</h1>",
      after: "export default () => <h1>أخبار اليوم</h1>",
    })).toBe("مقاولات السعادة")
  })

  test("also protects an existing shared component from a silent brand rewrite", () => {
    const projectDir = fixture()
    expect(projectIdentityViolation({
      projectDir,
      normalizedTarget: "app/components/site-shell.tsx",
      operation: "write",
      before: "export const Header = () => <header>مقاولات السعادة</header>",
      after: "export const Header = () => <header>التعاقدات الهندسية</header>",
    })).toBe("مقاولات السعادة")
  })

  test("allows identity-preserving writes and literal edits", () => {
    const projectDir = fixture()
    const base = { projectDir, normalizedTarget: "app/page.tsx", before: "<h1>مقاولات السعادة</h1>" }
    expect(projectIdentityViolation({ ...base, operation: "write", after: "<h1>مقاولات السعادة</h1><p>جديد</p>" })).toBeUndefined()
    expect(projectIdentityViolation({ ...base, operation: "edit", after: "<h1>اسم جديد</h1>" })).toBeUndefined()
  })

  test("derives domain anchors and refuses off-domain seed records", () => {
    const projectDir = fixture()
    writeFileSync(join(projectDir, "app", "layout.tsx"), 'export const metadata = { title: "مقاولات السعادة | نبني بثقة", description: "موقع عربي تعريفي لخدمات البناء والتشطيب والترميم وإدارة المشاريع" }')
    expect(readProjectDomainAnchors(projectDir)).toEqual(["البناء", "التشطيب", "الترميم"])
    expect(projectDomainViolation({
      projectDir,
      normalizedTarget: "lib/database-seed.ts",
      operation: "write",
      before: "",
      after: 'const rows = ["تطوير المواقع", "تطبيقات الجوال", "التسويق الرقمي"]',
    })).toEqual(["البناء", "التشطيب", "الترميم"])
    expect(projectDomainViolation({
      projectDir,
      normalizedTarget: "lib/database-seed.ts",
      operation: "write",
      before: "",
      after: 'const rows = ["البناء والتشييد", "تشطيبات داخلية", "ترميم المباني"]',
    })).toBeUndefined()
  })

  test("refuses a parallel contact route when inquiries already owns the API", () => {
    const projectDir = fixture()
    mkdirSync(join(projectDir, "app", "api", "inquiries"), { recursive: true })
    writeFileSync(join(projectDir, "app", "api", "inquiries", "route.ts"), "export const GET = () => null")
    expect(parallelApiRouteViolation({ projectDir, normalizedTarget: "app/api/contact/route.ts", operation: "write", before: "", after: "export const POST = () => null" })).toBe("inquiries")
    expect(parallelApiRouteViolation({ projectDir, normalizedTarget: "app/api/settings/route.ts", operation: "write", before: "", after: "export const GET = () => null" })).toBeUndefined()
  })
})
