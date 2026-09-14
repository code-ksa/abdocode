import { describe, expect, test } from 'bun:test'
import { Providers } from '../../desktop/ui/providers.js'
import { modelDisplayLabel, providerDisplayLabel } from '../../desktop/ui/provider-display.js'

describe('native English provider presentation', () => {
  test('uses the English directory labels for every built-in without changing IDs', () => {
    const expected: Record<string, string> = {
      deepseek: 'DeepSeek', ollama: 'Ollama', anthropic: 'Anthropic', openai: 'OpenAI',
      google: 'Google Gemini', xai: 'xAI', mistral: 'Mistral AI', groq: 'Groq',
      together: 'Together AI', moonshot: 'Moonshot / Kimi', dashscope: 'Alibaba Cloud / Qwen',
      'qwen-token-plan': 'Qwen Token Plan', 'qwen-coding-plan': 'Qwen Coding Plan',
      minimax: 'MiniMax', openrouter: 'OpenRouter', nvidia: 'NVIDIA NIM', meta: 'Meta Llama API',
    }
    expect(Object.fromEntries(Providers.PROVIDERS.map(provider => [
      provider.id,
      providerDisplayLabel(Providers, provider.id, provider.label, 'en'),
    ]))).toEqual(expected)
    expect(Providers.PROVIDERS.map(provider => provider.id)).toEqual(Object.keys(expected))
  })

  test('keeps owner labels and presents the selected fresh-install model', () => {
    expect(providerDisplayLabel(Providers, 'owner-models', 'اسم المالك', 'en')).toBe('اسم المالك')
    expect(Providers.DEFAULT_MODEL).toBe('qwen-token-plan/qwen3.7-plus')
    expect(modelDisplayLabel(Providers.DEFAULT_MODEL)).toBe('qwen3.7-plus')
    expect(modelDisplayLabel('deepseek/deepseek-v4-pro')).toBe('DeepSeek 4 Pro')
  })
})
