import { modelFetch } from '../model-fetch.mjs';
import { agentHomeId, modelFitsHome } from '../model-home';
import { assertEndpoint, assertCloudAccess } from '../server/network';
import { CLOUD_PROVIDERS, providerHeaders, chatPayload, completionPath } from '../cloud-providers.mjs';
import type { BuzzEnv } from './db';
import { unseal } from './secrets';

export type ModelConfig = { url: string; model: string; contextWindow: number; execution: 'vllm' | 'openclaw'; runtimeModel?: string; provider?: keyof typeof CLOUD_PROVIDERS; ownerId?: string; createdBy?: string; homeId?: string; nodeName?: string };
export type LocalModel = ModelConfig & { id: string; name: string; token?: string; error?: string };
export async function configuredModels(env: BuzzEnv, userId?: string): Promise<LocalModel[]> {
  const rows = await env.DB.prepare("SELECT * FROM connections WHERE kind='model' ORDER BY created_at").all<{ id: string; name: string; config: string; secret: string }>();
  const saved = await Promise.all(rows.results.map(async row => {
    const model = { ...JSON.parse(row.config) as ModelConfig, id: row.id, name: row.name, token: '' as string | undefined, error: undefined as string | undefined };
    try { model.token = await unseal(env, row.secret); } catch { model.error = 'Saved secret cannot be decrypted with the current SHOAL_SECRET_KEY.'; }
    return model;
  }));
  return saved.filter(model => !userId || !model.ownerId || model.ownerId === userId);
}
export async function selectedModel(env: BuzzEnv, agentId?: string, userId?: string): Promise<LocalModel> {
  const agentRow = agentId ? await env.DB.prepare("SELECT data FROM members WHERE id=? AND kind='agent'").bind(agentId).first<{ data: string }>() : null;
  if(agentId && !agentRow)throw new Error('Agent not found.');
  const agent=agentRow ? JSON.parse(agentRow.data) as {modelConnection?:string;runtime?:string;homeId?:string} : null;
  const models=(await configuredModels(env,userId)).filter(model=>!model.ownerId && (!agent || modelFitsHome(model,agentHomeId(agent))));
  const fallback=agent ? undefined : (await env.DB.prepare("SELECT value FROM settings WHERE key='inference_model'").first<{value:string}>())?.value;
  const selected=agent?.modelConnection || fallback;
  const model=selected ? models.find(model=>model.id===selected) : agent ? undefined : models[0];
  if(!model)throw new Error('Assign a connected model to this agent in Habitats or /model.');
  await assertModelEndpoint(env,model);
  if(model.error)throw new Error(model.error);
  if(model.execution==='openclaw' && env.BUZZ_OPENCLAW_URL)await assertEndpoint(env,env.BUZZ_OPENCLAW_URL);
  return model;
}
export async function probeModels(url: string | undefined, path = 'models', token?: string, provider?: string): Promise<{ up: boolean; models: string[]; error?: string }> {
  if (!url) return { up: false, models: [], error: 'No endpoint configured.' };
  try {
    const response = await modelFetch(new URL(path, url.replace(/\/$/, '') + '/'), { headers: providerHeaders(provider, token), redirect: 'error', signal: AbortSignal.timeout(8000) }, provider);
    if (!response.ok) { await response.body?.cancel(); return { up: false, models: [], error: response.status === 401 || response.status === 403 ? 'Authentication failed. Check the API key.' : `Endpoint returned HTTP ${response.status}.` }; }
    const data = await response.json() as { data?: { id: string; capabilities?: { completion_chat?: boolean }; type?: string }[] };
    const models = (data.data || []).filter(item => item.capabilities?.completion_chat !== false && !['image', 'audio', 'embedding', 'rerank'].includes(item.type || '')).map(item => item.id).filter(id => typeof id === 'string');
    return { up: Array.isArray(data.data), models: [...new Set(models)].sort() };
  } catch (error) { return { up: false, models: [], error: error instanceof Error ? error.message : 'Model endpoint unavailable.' }; }
}
export async function modelAvailability(env: BuzzEnv, userId?: string) {
  return Promise.all((await configuredModels(env, userId)).map(async model => {
    try {await assertModelEndpoint(env,model);} catch {return {id:model.id,name:model.name,model:model.model,execution:model.execution,provider:model.provider,homeId:model.homeId,nodeName:model.nodeName,status:'unavailable' as const};}
    const observed = await probeModels(model.url, 'models', model.token, model.provider);
    return { id: model.id, name: model.name, model: model.model, execution: model.execution, provider: model.provider, homeId: model.homeId, nodeName: model.nodeName, status: observed.up && observed.models.includes(model.model) ? 'ready' as const : 'unavailable' as const };
  }));
}
export async function retrievalEnvironment(env: BuzzEnv): Promise<BuzzEnv> {
  const rows = await env.DB.prepare("SELECT kind,config,secret FROM connections WHERE kind IN ('embedding','rerank') ORDER BY created_at").all<{ kind: string; config: string; secret: string }>();
  const resolved = { ...env };
  for (const row of rows.results) {
    const config = JSON.parse(row.config) as ModelConfig;
    const token = await unseal(env, row.secret).catch(() => '');
    if (row.kind === 'embedding') Object.assign(resolved, { BUZZ_EMBED_URL: config.url, BUZZ_EMBED_MODEL: config.model, BUZZ_EMBED_TOKEN: token });
    else Object.assign(resolved, { BUZZ_RERANK_URL: config.url.replace(/\/v1\/?$/, ''), BUZZ_RERANK_MODEL: config.model, BUZZ_RERANK_TOKEN: token });
  }
  for (const url of [resolved.BUZZ_EMBED_URL,resolved.BUZZ_RERANK_URL]) if(url) await assertEndpoint(env,url);
  return resolved;
}

export async function assertModelEndpoint(env: BuzzEnv, model: ModelConfig, personal = false) {
  if (!model.provider) return assertEndpoint(env, model.url, personal);
  if (model.url !== CLOUD_PROVIDERS[model.provider]?.url || model.execution !== 'vllm') throw new Error('Cloud credentials can only be sent to the selected provider’s official API.');
  await assertCloudAccess(env);
}
export async function testModel(model: LocalModel) {
  const started = Date.now();
  const response = await modelFetch(`${model.url}/${completionPath(model.provider)}`, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...providerHeaders(model.provider, model.token) },
    body: JSON.stringify(chatPayload({ provider: model.provider, model: model.model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: Math.min(2048, model.contextWindow - 256) })), signal: AbortSignal.timeout(45000) }, model.provider);
  const data = await response.json().catch(() => null) as { content?: { type: string; text?: string }[]; choices?: { message?: { content?: string } }[] } | null;
  const answer = model.provider === 'anthropic' ? data?.content?.filter(block => block.type === 'text').map(block => block.text || '').join('') : data?.choices?.[0]?.message?.content;
  if (!response.ok || !answer?.trim()) throw new Error(`Model test failed (HTTP ${response.status}). Check API access, credits, and the selected model.`);
  return { latencyMs: Date.now() - started, message: answer.slice(0, 300) };
}
