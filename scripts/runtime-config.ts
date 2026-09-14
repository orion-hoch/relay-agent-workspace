import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../lib/server/env';
import { ensureSchema } from '../lib/buzz/db';
import { configuredModels } from '../lib/buzz/models';
try {
  await ensureSchema(env);
  const providers: Record<string, unknown> = {};
  const aliases: Record<string, { alias: string }> = {};
  for (const model of await configuredModels(env)) {
    if (model.execution !== 'openclaw') continue;
    const route = model.runtimeModel || `shoal-${model.id}/${model.model}`;
    const slash = route.indexOf('/');
    if (slash < 1 || route.slice(slash + 1) !== model.model) throw new Error(`For ${model.name}, use a runtime ID of provider/${model.model} so the served model matches.`);
    const provider = route.slice(0, slash);
    if (providers[provider]) throw new Error('Give each saved endpoint its own OpenClaw provider name.');
    providers[provider] = { baseUrl: model.url, apiKey: model.token || 'local', api: 'openai-completions', models: [{ id: model.model, name: model.name, contextWindow: model.contextWindow, maxTokens: 4096 }] };
    aliases[route] = { alias: model.name };
  }
  const target = resolve(process.env.SHOAL_DATA_DIR || '.shoal', 'openclaw-models.json');
  await mkdir(resolve(target,'..'), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify({ models: { mode: 'merge', providers }, agents: { defaults: { models: aliases } } }, null, 2), { mode: 0o600 });
  console.log(`Wrote ${Object.keys(providers).length} model providers to ${target}. Merge this protected file into your native runtime configuration. It contains credentials.`);
} finally { await env.DB.close(); }
