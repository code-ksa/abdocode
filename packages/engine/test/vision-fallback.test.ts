import { describe, expect, test } from "bun:test"
import { shotFitsModel, shotRoute, tilePlan } from "../src/vision-fallback"

describe("full-page tiles: one per viewport, the last flush with the document bottom, never unbounded", () => {
  test("short page is one tile; a 3.5-viewport page is four tiles ending at the bottom", () => {
    expect(tilePlan(900, 600)).toEqual([0])
    expect(tilePlan(900, 3150)).toEqual([0, 900, 1800, 2250])
  })
  test("a very long page is capped and still ends at the bottom", () => {
    const plan = tilePlan(900, 90_000, 8)
    expect(plan).toHaveLength(8)
    expect(plan.at(-1)).toBe(90_000 - 900)
    expect(plan.slice(0, 7)).toEqual([0, 900, 1800, 2700, 3600, 4500, 5400])
  })
})
import { MAX_IMAGE_BASE64 } from "@abdo/model-gateway"

describe("a shot only travels when it fits the gateway's image cap (a real page PNG was ~713k chars and killed the turn)", () => {
  test("cap boundary is the gateway's own constant", () => {
    expect(shotFitsModel("A".repeat(MAX_IMAGE_BASE64))).toBe(true)
    expect(shotFitsModel("A".repeat(MAX_IMAGE_BASE64 + 1))).toBe(false)
    expect(shotFitsModel("")).toBe(false)
  })
})

describe("a screenshot reaches the model that can actually see it", () => {
  test("no vision model, but the lane model declares image input (the measured Qwen default) → the lane sees", () => {
    expect(shotRoute({ agentModel: "qwen-token-plan/qwen3.7-plus" })).toEqual({ reaches: true, via: "lane", ref: "qwen-token-plan/qwen3.7-plus" })
  })
  test("an explicit vision model wins over the lane", () => {
    expect(shotRoute({ visionModel: "qwen-token-plan/qwen3.8-max", agentModel: "qwen-token-plan/qwen3.7-max" })).toEqual({ reaches: true, via: "vision", ref: "qwen-token-plan/qwen3.8-max" })
  })
  test("twin: a text-only lane (qwen3.7-max refused images live) and no vision model → the truth is said, nothing is attached", () => {
    const route = shotRoute({ agentModel: "qwen-token-plan/qwen3.7-max" })
    expect(route.reaches).toBe(false)
    expect(shotRoute({ model: "ollama/qwen9b-gpu-32k:latest" }).reaches).toBe(false)
    expect(shotRoute({ visionModel: "not-a-ref", agentModel: "qwen-token-plan/qwen3.7-max" }).reaches).toBe(false)
  })
})
