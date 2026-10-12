/**
 * 10-08 — المهمّة الكاملة: `npm install next@16.4.0 tailwindcss@4.3.3` فوق next ^14 وtailwind ^3 لإصلاح npm audit ⇦ بناءٌ مكسور ودورٌ في الهجرة.
 */
import { expect, test } from "bun:test"
import { majorUpgradeViolation } from "../src/major-upgrade-guard"

const pkg = JSON.stringify({ dependencies: { next: "^14.2.15", react: "18.3.1" }, devDependencies: { tailwindcss: "^3.4.14", vitest: "^2.1.9", "@types/node": "^20" } })

test("the measured command is refused, naming both jumps and the safe path", () => {
  const r = majorUpgradeViolation("npm install next@16.4.0 tailwindcss@4.3.3 vitest@5.0.3", pkg)
  expect(r).toBeDefined()
  for (const s of ["next 14 ⇦ 16", "tailwindcss 3 ⇦ 4", "vitest 2 ⇦ 5", "npm audit fix", "# major-upgrade:"]) expect(r!).toContain(s)
})

test("other managers and scoped names are caught", () => {
  expect(majorUpgradeViolation("pnpm add @types/node@22", pkg)).toContain("@types/node 20 ⇦ 22")
  expect(majorUpgradeViolation("cd app; yarn add next@15", pkg)).toContain("next 14 ⇦ 15")
})

test("positive twins: same-major upgrades, new packages, plain installs, and a justified jump pass", () => {
  for (const cmd of ["npm install next@14.2.33", "npm i zod@3", "npm install", "npm ci", "npm audit fix", "npm install next@latest", "npm install next@16 # major-upgrade: the owner asked for Next 16"]) {
    expect(majorUpgradeViolation(cmd, pkg)).toBeUndefined()
  }
  expect(majorUpgradeViolation("npm install next@16", undefined)).toBeUndefined()
})
