import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { projectInstructionsFor, validateProjectInstructions } from "../src/project-instructions"

test("project instructions have a strict, bounded, explicit path contract", () => {
  const path = resolve("project-alpha")
  expect(validateProjectInstructions({ path, text: "x ".repeat(6000) })).toBeUndefined()
  expect(validateProjectInstructions({ path, text: "x ".repeat(6000) + "x" })).toBeDefined()
  expect(validateProjectInstructions({ path: "relative-project", text: "instruction" })).toBeDefined()
  expect(validateProjectInstructions({ path: path + "\nother", text: "instruction" })).toBeDefined()
  expect(validateProjectInstructions({ path, text: "instruction", autoApprove: true })).toBeDefined()
  expect(projectInstructionsFor(undefined, path)).toBe("")
  expect(projectInstructionsFor({ path, text: " " }, path)).toBe("")
})

test("only the resolved matching path receives instructions, never a sibling or child", () => {
  const path = resolve("project-alpha")
  const instructions = { path, text: "Use measured evidence for this project." }
  expect(projectInstructionsFor(instructions, resolve(path, "."))).toContain(instructions.text)
  expect(projectInstructionsFor(instructions, resolve(path, "child"))).toBe("")
  expect(projectInstructionsFor(instructions, resolve("project-beta"))).toBe("")
})
