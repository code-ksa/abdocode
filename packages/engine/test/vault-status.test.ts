import { expect, test } from "bun:test"
import { createVaultStatusReporter } from "../src/vault-status"

test("concurrent vault requests share one serial metadata snapshot and later requests refresh", async () => {
  let release!: (value: boolean) => void
  const first = new Promise<boolean>(resolve => { release = resolve })
  const calls: string[] = [], frames: unknown[] = []
  const reporter = createVaultStatusReporter({
    providers: () => ["present", "broken", "present"],
    hasCredential: async provider => {
      calls.push(provider)
      if (provider === "broken") throw new Error("fixture-private-credential-value")
      return calls.length === 1 ? first : false
    },
    emit: frame => frames.push(frame),
  })
  for (let i = 0; i < 30; i++) expect(reporter.request()).toBeUndefined()
  await Bun.sleep(0)
  expect(calls).toEqual(["present"])
  expect(frames).toEqual([])
  release(true)
  await Bun.sleep(0)
  expect(calls).toEqual(["present", "broken"])
  expect(frames).toEqual([{ kind: "vault-status", status: [{ provider: "present", hasKey: true }, { provider: "broken", hasKey: false }] }])
  expect(JSON.stringify(frames)).not.toContain("fixture-private")
  reporter.request()
  await Bun.sleep(0)
  expect(calls).toEqual(["present", "broken", "present", "broken"])
  expect((frames[1] as any).status[0].hasKey).toBe(false)
})

test("shutdown prevents more credential probes or late replies", async () => {
  let release!: (value: boolean) => void
  const calls: string[] = [], frames: unknown[] = []
  const reporter = createVaultStatusReporter({
    providers: () => ["first", "second"],
    hasCredential: provider => { calls.push(provider); return new Promise(resolve => { release = resolve }) },
    emit: frame => frames.push(frame),
  })
  reporter.request()
  await Bun.sleep(0)
  reporter.dispose()
  release(true)
  await Bun.sleep(0)
  reporter.request()
  await Bun.sleep(0)
  expect(calls).toEqual(["first"])
  expect(frames).toEqual([])
})
