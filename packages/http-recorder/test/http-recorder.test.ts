import { expect, test } from "bun:test"
import { recordHttp } from "../src"
test("records bounded metadata without credentials", () => {
  const record = recordHttp({ method: "get", url: "https://example.test/a?secret=x", headers: { Authorization: "Bearer secret", ETag: "v1" } })
  expect(record.path).toBe("/a")
  expect(record.headers).toEqual({ etag: "v1" })
  expect(JSON.stringify(record)).not.toContain("secret")
})
