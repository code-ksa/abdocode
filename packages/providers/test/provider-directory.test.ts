import { describe, expect, test } from "bun:test"
import { PROVIDER_DEFINITIONS, PROVIDER_TEMPLATES, DEFAULT_MODEL } from "../src/catalog"
import { customProviderEnvValue, prepareChatRequest, provider, registerCustomProvider, seedCatalog, Providers, syncCustomProviders } from "../src"

describe("native provider directory", () => {
  test("contains every shell template and preserves the native NVIDIA and Meta providers", () => {
    expect(PROVIDER_TEMPLATES).toHaveLength(43)
    expect(new Set(PROVIDER_TEMPLATES.map((item) => item.id)).size).toBe(43)
    for (const builtin of PROVIDER_DEFINITIONS) {
      expect(PROVIDER_TEMPLATES.find((entry) => entry.id === builtin.id)).toMatchObject({
        support: "builtin", baseUrl: builtin.baseUrl, models: builtin.models,
      })
    }
    expect(PROVIDER_TEMPLATES.find((item) => item.id === "bedrock")?.support).toBe("gateway-required")
    expect(PROVIDER_TEMPLATES.find((item) => item.id === "lmstudio")?.support).toBe("local-compatible")
  })

  test("DeepSeek uses its real worker endpoint, vault handle and explicit tool-compatible thinking mode", () => {
    expect(DEFAULT_MODEL).toBe("qwen-token-plan/qwen3.7-plus")
    const deepseek = provider("deepseek")!
    const request = prepareChatRequest({ provider: deepseek, model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello" }], nativeTools: true, think: true, stream: false, credentialOwner: "rust-worker" })
    expect(request.url).toBe("https://api.deepseek.com/chat/completions")
    expect(deepseek.vaultKey).toBe("abdocode-deepseek")
    expect(request.credential).toBe("bearer")
    expect(request.headers.authorization).toBeUndefined()
    expect(JSON.parse(request.body)).toMatchObject({ model: "deepseek-v4-flash", thinking: { type: "disabled" } })
    expect(() => prepareChatRequest({ provider: deepseek, model: "deepseek-v4-flash", messages: [], stream: false })).toThrow("vault credential")
  })

  test("local OpenAI-compatible servers are selectable and never announce a cloud credential to Rust", () => {
    const config = { id: "local-test-server", label: "Local test server", baseUrl: "http://127.0.0.1:12345/v1", vaultKey: "", local: true, models: ["local-coder", "local-chat"] }
    expect(registerCustomProvider(config)).toBeUndefined()
    const local = provider(config.id)!
    const request = prepareChatRequest({ provider: local, model: "local-coder", messages: [{ role: "user", content: "hello" }], stream: false })
    expect(request.url).toBe("http://127.0.0.1:12345/v1/chat/completions")
    expect(request.credential).toBe("none")
    expect(request.headers.authorization).toBeUndefined()
    expect(customProviderEnvValue([config])).toBeUndefined()
    expect(seedCatalog().find((entry) => entry.ref === "local-test-server/local-coder")?.needsKey).toBe(false)
    expect(registerCustomProvider(config)).toBeUndefined()
  })

  test("local switches cannot smuggle cloud credentials or remote HTTP endpoints", () => {
    const config = { id: "local-smuggle", label: "Local", baseUrl: "http://api.example.com/v1", vaultKey: "", local: true }
    expect(registerCustomProvider(config)).toContain("loopback")
    expect(registerCustomProvider({ ...config, baseUrl: "http://127.0.0.1:12345/v1", vaultKey: "abdocode-openai" })).toContain("اعتماد")
    expect(registerCustomProvider({ ...config, baseUrl: "http://127.0.0.1.evil.example/v1" })).toContain("loopback")
    expect(provider(config.id)).toBeUndefined()
  })

  test("remote template configuration keeps models in the live catalog and secrets out of it", () => {
    const config = { id: "directory-cloud", label: "Directory cloud", baseUrl: "https://api.example.com/v1", vaultKey: "custom-directory-cloud-api-key", models: ["org/model-one", "model-two"] }
    expect(registerCustomProvider(config)).toBeUndefined()
    expect(seedCatalog().filter((entry) => entry.provider.id === config.id).map((entry) => entry.ref)).toEqual(["directory-cloud/org/model-one", "directory-cloud/model-two"])
    expect(customProviderEnvValue([config])).toBe("directory-cloud|https://api.example.com/v1/chat/completions|custom-directory-cloud-api-key")
    for (const baseUrl of ["https://user:password@api.example.com/v1", "https://api.example.com/v1?token=secret", "https://api.example.com/v1#fragment"]) {
      expect(registerCustomProvider({ ...config, id: "bad-directory-cloud", baseUrl })).toContain("عنوان")
      expect(customProviderEnvValue([{ ...config, baseUrl }])).toBeUndefined()
    }
  })

  test("explicit owner snapshot replacement updates and removes atomically, without overriding builtins", () => {
    const before = Providers.listProviders().filter((item) => item.source === "owner-config").map((item) => ({ ...item, vaultKey: item.vaultKey ?? "" }))
    const original = { id: "atomic-cloud", label: "Original", baseUrl: "https://old.example/v1", vaultKey: "custom-atomic-cloud", models: ["old-model"] }
    const changed = { ...original, label: "Changed", baseUrl: "https://new.example/v1", models: ["new-model"] }
    try {
      expect(syncCustomProviders([original])).toEqual([])
      const priorObject = provider(original.id)!
      expect(syncCustomProviders([changed], { dryRun: true })).toEqual([])
      expect(provider(original.id)).toBe(priorObject)
      expect(syncCustomProviders([changed, { ...changed, id: "bad-sibling", baseUrl: "http://remote.example/v1" }])).not.toEqual([])
      expect(provider(original.id)).toBe(priorObject)
      expect(syncCustomProviders([{ ...changed, id: "deepseek" }])).not.toEqual([])
      expect(provider("deepseek")?.baseUrl).toBe("https://api.deepseek.com")
      expect(syncCustomProviders([changed])).toEqual([])
      expect(provider(original.id)).toMatchObject({ baseUrl: changed.baseUrl, models: ["new-model"] })
      expect(priorObject.baseUrl).toBe(original.baseUrl)
      expect(syncCustomProviders([])).toEqual([])
      expect(provider(original.id)).toBeUndefined()
      expect(Providers.parseRef("atomic-cloud/new-model")).toBeUndefined()
      expect(provider("deepseek")?.models).toContain("deepseek-v4-flash")
    } finally { expect(syncCustomProviders(before)).toEqual([]) }
  })
})
