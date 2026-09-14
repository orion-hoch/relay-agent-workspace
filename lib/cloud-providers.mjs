// Direct APIs share the chat transport; Claude uses its native Messages protocol.
// Keep model choice account-driven.
export const CLOUD_PROVIDERS = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', keys: 'https://platform.openai.com/api-keys' },
  anthropic: { name: 'Anthropic / Claude', url: 'https://api.anthropic.com/v1', keys: 'https://platform.claude.com/settings/keys' },
  google: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', keys: 'https://aistudio.google.com/api-keys' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keys: 'https://openrouter.ai/settings/keys' },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', keys: 'https://platform.deepseek.com/api_keys' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1', keys: 'https://console.groq.com/keys' },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1', keys: 'https://console.mistral.ai/api-keys' },
  together: { name: 'Together AI', url: 'https://api.together.ai/v1', keys: 'https://api.together.ai/settings/api-keys' },
  xai: { name: 'xAI / Grok', url: 'https://api.x.ai/v1', keys: 'https://console.x.ai' },
  cerebras: { name: 'Cerebras', url: 'https://api.cerebras.ai/v1', keys: 'https://cloud.cerebras.ai/platform' },
};
/** @returns {Record<string, string>} */
export function providerHeaders(provider, token = '') {
  if (provider === 'anthropic') return { 'x-api-key': token, 'anthropic-version': '2023-06-01' };
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(provider === 'google' ? { 'x-goog-api-client': 'shoal/0.1.0' } : {}) };
}
export function chatPayload({ provider = '', model, messages, maxTokens = 2048, stream = false }) {
  if (provider === 'anthropic') return { model, system: messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n'), messages: messages.filter(item => item.role !== 'system'), max_tokens: maxTokens, stream };
  return { model, messages, stream,
    ...(stream && ['', 'openai', 'openrouter', 'deepseek', 'groq', 'together', 'xai', 'cerebras'].includes(provider) ? { stream_options: { include_usage: true } } : {}),
    ...(provider === 'openai' ? { max_completion_tokens: maxTokens, store: false } : { max_tokens: maxTokens }) };
}
export const completionPath = provider => provider === 'anthropic' ? 'messages' : 'chat/completions';
