/** Locale-aware presentation for built-in providers.
 * Runtime IDs and owner-configured labels remain byte-for-byte unchanged. */
export function providerDisplayLabel(catalog, providerId, fallback, language = 'en') {
  if (language !== 'en') return fallback;
  const builtIn = (catalog?.PROVIDERS || []).some(provider => provider.id === providerId);
  if (!builtIn) return fallback;
  return (catalog?.PROVIDER_TEMPLATES || []).find(template => template.id === providerId)?.label || fallback;
}

export function modelDisplayLabel(ref) {
  const model = String(ref || '').split('/').slice(1).join('/') || String(ref || '');
  if (model === 'deepseek-v4-flash') return 'DeepSeek 4 Flash';
  if (model === 'deepseek-v4-pro') return 'DeepSeek 4 Pro';
  return model;
}
