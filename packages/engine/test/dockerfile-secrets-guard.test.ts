/**
 * 10-08 (مقيس في بروفة النشر): `COPY . .` ومعه .env بلا .dockerignore ⇦ المفاتيحُ في الصورة. والتوائم: .dockerignore يستبعده، أو لا .env،
 * أو نسخٌ بالأسماء، أو ملفٌّ ليس Dockerfile — كلُّها تمرّ.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerfileSecretsViolation } from "../src/dockerfile-secrets-guard"

const DOCKERFILE = "FROM node:22\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD [\"node\", \"server.js\"]\n"

test("COPY . . with a .env and no .dockerignore excluding it is refused, with the route", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-dockerfile-"))
  try {
    writeFileSync(join(dir, ".env"), "APP_SECRET=x\n")
    const why = dockerfileSecretsViolation(dir, "Dockerfile", DOCKERFILE)!
    expect(why).toContain(".env")
    expect(why).toContain(".dockerignore")
    expect(dockerfileSecretsViolation(dir, "Dockerfile.prod", "FROM node\nADD . /app\n")).toBeDefined()
    writeFileSync(join(dir, ".dockerignore"), "node_modules\n.git\n")
    expect(dockerfileSecretsViolation(dir, "Dockerfile", DOCKERFILE)).toBeDefined()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the twins: an ignore line, no .env, copying by name, or a non-Dockerfile all pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-dockerfile-"))
  try {
    expect(dockerfileSecretsViolation(dir, "Dockerfile", DOCKERFILE)).toBeUndefined()
    writeFileSync(join(dir, ".env"), "APP_SECRET=x\n")
    expect(dockerfileSecretsViolation(dir, "Dockerfile", "FROM node:22\nCOPY server.js package.json ./\n")).toBeUndefined()
    expect(dockerfileSecretsViolation(dir, "README.md", DOCKERFILE)).toBeUndefined()
    writeFileSync(join(dir, ".dockerignore"), "node_modules\n.env*\n")
    expect(dockerfileSecretsViolation(dir, "Dockerfile", DOCKERFILE)).toBeUndefined()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
