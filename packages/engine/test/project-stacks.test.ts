import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectStack, detectStackForProject, STACKS, stackById } from "../src/project-stacks"
import { sprintPlanWriteViolation, sprintPlanTemplate } from "../src/project-sprint-plan-guard"

describe("stack detection — multi-framework", () => {
  test("detects each stack from goal text", () => {
    expect(detectStack("موقع Next.js عربي RTL بقاعدة SQLite").id).toBe("next")
    expect(detectStack("تطبيق React + Vite لوحة تحكم").id).toBe("vite-react")
    expect(detectStack("واجهة برمجية بـFastify وقاعدة").id).toBe("fastify")
    expect(detectStack("صفحة هبوط HTML + Tailwind ساكنة").id).toBe("static-html")
  })

  test("vite wins over react-only, next is the sensible fallback", () => {
    expect(detectStack("react app with vite").id).toBe("vite-react")
    expect(detectStack("مشروع ويب عام").id).toBe("next")
  })

  test("every stack template passes the plan guard it will be offered by", () => {
    for (const s of STACKS) {
      const dir = mkdtempSync(join(tmpdir(), "abdo-stk-"))
      const v = sprintPlanWriteViolation({ projectDir: dir, normalizedTarget: "ABDO-SPRINTS.md", after: sprintPlanTemplate("مشروع", s.id) }, true)
      expect(v).toBeUndefined()
    }
  })

  test("a React+Vite plan is NOT rejected for lacking Next.js/SQLite anchors", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-vite-"))
    const plan = sprintPlanTemplate("لوحة تحكم", "vite-react")
    expect(sprintPlanWriteViolation({ projectDir: dir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
    expect(plan).not.toContain("SQLite")
    expect(plan).toContain("Vite")
  })

  test("a static HTML plan passes without any build/npm evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-html-"))
    const plan = sprintPlanTemplate("صفحة هبوط", "static-html")
    expect(sprintPlanWriteViolation({ projectDir: dir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
    expect(plan).not.toContain("npm run build")
  })

  test("detects rust, go and cpp from arabic and english goals", () => {
    expect(detectStack("أداة سطر أوامر بلغة Rust").id).toBe("rust")
    expect(detectStack("cargo project for parsing").id).toBe("rust")
    expect(detectStack("خدمة Go صغيرة").id).toBe("go")
    expect(detectStack("اكتب برنامج جو").id).toBe("go")
    expect(detectStack("برنامج C++ للتحليل").id).toBe("cpp")
    expect(detectStack("اكتب سي بلس بلس").id).toBe("cpp")
  })

  // درسنا الموثّق: \b لا يطابق العربية — «جو» العارية طابقت «موجود».
  test("arabic 'جو' inside a word does not misdetect go", () => {
    expect(detectStack("الملف موجود وصالح HTML صفحة ساكنة").id).toBe("static-html")
  })

  test("rust/go/cpp templates carry their own toolchain evidence, not npm", () => {
    expect(sprintPlanTemplate("مشروع", "rust")).toContain("cargo test")
    expect(sprintPlanTemplate("مشروع", "go")).toContain("go test ./...")
    expect(sprintPlanTemplate("مشروع", "cpp")).toContain("vcvars64")
    expect(sprintPlanTemplate("مشروع", "rust")).not.toContain("npm")
  })

  // الحادثة الحية (إيدو جلوبال 2026-09-02): «واسم» داخل «واسمها» صنّفت خطة Next
  // على أنها AssemblyScript فرُفضت حقبةً بعد حقبة. الحروف العربية لا يحدّها \b.
  test("arabic transliterations match only as whole words — no hijack from inside words", () => {
    expect(detectStack("منصة تعليمية عربية لا تختلق أرقاماً واسمها كما هو").id).not.toBe("wasm")
    expect(detectStack("نراجع دراستنا لتطبيق الويب").id).not.toBe("rust")
    expect(detectStack("قائمة مزيجية للطلاب").id).not.toBe("zig")
    // الكلمة المستقلة ما زالت تكتشف.
    expect(detectStack("وحدة واسم تُصرَّف بأداة asc").id).toBe("wasm")
    expect(detectStack("خدمة بلغة راست").id).toBe("rust")
  })

  test("workspace-filtered commands count as executable evidence for node stacks", () => {
    const next = stackById("next")!
    const text = [
      "نفّذ: run pnpm --filter @taalim/web build",
      "نفّذ: run pnpm -F web test",
      "نفّذ: run npm -w apps/web run build",
      "نفّذ: run pnpm --filter=@taalim/web run start",
      "نفّذ: run pnpm run build",
    ].join("\n")
    expect(text.match(next.evidence)?.length).toBe(5)
  })

  test("an existing repository decides the stack; plan prose decides only for an empty project", () => {
    const repo = mkdtempSync(join(tmpdir(), "abdo-stack-repo-"))
    mkdirSync(join(repo, "apps", "web"), { recursive: true })
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mono", private: true }))
    writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "^16.2.0" } }))
    const detected = detectStackForProject(repo, "تحديث التصميم واسمها الجديد")
    expect(detected.source).toBe("repo")
    expect(detected.stack.id).toBe("next")
    const empty = mkdtempSync(join(tmpdir(), "abdo-stack-empty-"))
    const fromText = detectStackForProject(empty, "تطبيق React + Vite لوحة تحكم")
    expect(fromText.source).toBe("text")
    expect(fromText.stack.id).toBe("vite-react")
    const rust = mkdtempSync(join(tmpdir(), "abdo-stack-rust-"))
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n")
    expect(detectStackForProject(rust, "موقع Next.js").stack.id).toBe("rust")
  })

  test("stackById round-trips known ids and rejects unknown", () => {
    expect(stackById("fastify")?.label).toContain("Fastify")
    expect(stackById("nope")).toBeUndefined()
  })
})
