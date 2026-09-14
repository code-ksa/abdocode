import { describe, expect, test } from "bun:test"
import { foundingAllowlist, projectManifestViolation } from "../src/project-manifest-guard"

const base = {
  projectDir: "C:\\qualification\\client-site",
  normalizedTarget: "package.json",
  operation: "write" as const,
  before: "",
}

describe("fresh project manifest guard", () => {
  test("rejects prose appended after the JSON object", () => {
    expect(projectManifestViolation({ ...base, after: '{"name":"al-saada-contracting"}\nالملف تم إنشاؤه' })).toContain("ليس JSON صالحاً")
  })

  test("rejects an invented dependency before npm can contact the registry", () => {
    expect(projectManifestViolation({
      ...base,
      after: '{"dependencies":{"next":"latest","react":"latest","react-dom":"latest","next-router-pgl":"latest"}}',
    })).toContain("next-router-pgl")
  })

  test("allows the minimal Next and TypeScript bootstrap manifest", () => {
    expect(projectManifestViolation({
      ...base,
      after: '{"dependencies":{"next":"latest","react":"latest","react-dom":"latest"},"devDependencies":{"@types/node":"latest","@types/react":"latest","@types/react-dom":"latest","typescript":"latest"}}',
    })).toBeUndefined()
  })

  test("2026-09-13: a goal naming Vite + Tailwind admits the Vite founding set and still refuses next; the default stays Next", () => {
    const vite = '{"dependencies":{"react":"18","react-dom":"18","react-router-dom":"6"},"devDependencies":{"vite":"5","@vitejs/plugin-react":"4","tailwindcss":"3","postcss":"8","autoprefixer":"10","typescript":"5"}}'
    expect(projectManifestViolation({ ...base, after: vite }, "حوّل المشروع إلى Vite + React + Tailwind")).toBeUndefined()
    expect(projectManifestViolation({ ...base, after: vite })).toContain("react-router-dom")
    expect(projectManifestViolation({ ...base, after: '{"dependencies":{"next":"14"}}' }, "اعمل مشروع فيت")).toContain("next")
    expect(foundingAllowlist("مشروع next مع tailwind").development.has("tailwindcss")).toBe(true)
    expect(foundingAllowlist("").development.has("tailwindcss")).toBe(false)
    expect(foundingAllowlist("vite").stack).toBe("vite")
    // مراجعة 09-14: vitejs يُحسب؛ «من Next إلى Vite» يفوز الأخيرُ ذكراً؛ «invite» ليست vite.
    expect(foundingAllowlist("استخدم vitejs مع tailwind").stack).toBe("vite")
    expect(foundingAllowlist("حوّل المشروع من Next.js إلى Vite").stack).toBe("vite")
    expect(foundingAllowlist("move from vite to next").stack).toBe("next")
    expect(foundingAllowlist("send an invite email").stack).toBe("next")
  })
  test("does not freeze later task-specific dependency revisions", () => {
    expect(projectManifestViolation({ ...base, before: "{}", after: '{"dependencies":{"better-sqlite3":"1.0.0"}}' })).toBeUndefined()
  })
})
