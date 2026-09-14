import { describe, expect, test } from "bun:test"
import { tsxSourceViolation } from "../src/tsx-source-guard"

const base = { projectDir: "C:\\project", normalizedTarget: "app/components/site-shell.tsx", operation: "write" as const, before: "" }

describe("TSX source guard", () => {
  test("rejects trailing Arabic commentary in the live model's database module", () => {
    expect(tsxSourceViolation({ ...base, normalizedTarget: "app/lib/db.ts", after: 'export const db = {}\nالخطوة التالية: تثبيت الحزم المطلوبة' })).toContain("صياغة ts")
  })

  test("allows ordinary scripts and TS-only generic syntax without requiring JSX", () => {
    expect(tsxSourceViolation({ ...base, normalizedTarget: "scripts/check.ts", after: 'const identity = <T>(value: T): T => value; console.log(identity(1))' })).toBeUndefined()
  })

  test("rejects indented pseudocode stored as tsx", () => {
    expect(tsxSourceViolation({ ...base, after: 'html lang="ar"\n  body\n    header class="header"' })).toContain("صياغة")
  })

  test("rejects a source module with no JSX result", () => {
    expect(tsxSourceViolation({ ...base, after: "export const value = 1" })).toContain("JSX")
  })

  test("allows an exported React component", () => {
    expect(tsxSourceViolation({ ...base, after: "export const Header = () => <header />" })).toBeUndefined()
  })

  test("rejects the stray colon produced by the live Qwen write", () => {
    expect(tsxSourceViolation({ ...base, after: ':\nexport default function Page() { return <main /> }' })).toContain("صياغة")
  })

  test("checks resulting edits before they corrupt an existing component", () => {
    expect(tsxSourceViolation({ ...base, operation: "edit", after: 'export default function Page() { return <main> }' })).toContain("صياغة")
  })

  test("does not load imports or execute top-level source during validation", () => {
    expect(tsxSourceViolation({ ...base, after: 'import absent from "not-installed"; throw new Error("never execute"); export const Page = () => <main>{absent}</main>' })).toBeUndefined()
  })
})

// قيس حيّاً (جولة Vite): الحارس صدّ ملف الدخول الصحيح مرتين.
import { test as entryTest, expect as entryExpect } from "bun:test"
entryTest("a mounting entry file (createRoot) needs no export", () => {
  const after = "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')!).render(<App />)"
  entryExpect(tsxSourceViolation({ projectDir: "x", normalizedTarget: "src/main.tsx", operation: "write", before: "", after })).toBeUndefined()
})
entryTest("a component file without export is still rejected", () => {
  entryExpect(tsxSourceViolation({ projectDir: "x", normalizedTarget: "src/Card.tsx", operation: "write", before: "", after: "function Card(){ return <div/> }" })).toContain("بلا export")
})
