import type { Provider } from './index'

/** Cloud IDs here have a published image-input contract. Unknown models stay
 * text-only unless the owner explicitly configures their image capability. */
export function hasDeclaredImageInput(provider: Provider, model: string): boolean {
  if(provider.imageModels?.includes(model))return true
  if(provider.id==='openai'&&/^(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?)(?:$|-20)/u.test(model))return true
  if(provider.id==='anthropic'&&/^claude-(?:3|sonnet-4|opus-4|haiku-4)/u.test(model))return true
  return false
}
