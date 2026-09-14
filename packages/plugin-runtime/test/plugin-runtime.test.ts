import { expect, test } from "bun:test"
import { localPluginDigest, validateLocalPlugin } from "../src"
test("accepts only explicit local plugin manifests", () => {
  const manifest = validateLocalPlugin({ id: "formatter", version: "1.0.0", entry: "dist/index.js", permissions: ["read-project"] })
  expect(localPluginDigest(manifest)).toHaveLength(64)
  expect(() => validateLocalPlugin({ ...manifest, entry: "https://upstream.test/plugin.js" })).toThrow("plugin_entry_must_be_local")
})
