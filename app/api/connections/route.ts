import { modelFetch } from '@/lib/model-fetch.mjs';
import { localHomeId } from '@/lib/model-home';
import { assertEndpoint } from '@/lib/server/network';
import { actor, isAdmin } from '@/lib/server/team';
import { env } from '@/lib/server/env';
import { body, fail, id, now, ok } from '@/lib/buzz/db';
import { configuredModels, probeModels, testModel, type ModelConfig } from '@/lib/buzz/models';
import { seal, unseal } from '@/lib/buzz/secrets';

type Input = { id?: string; kind?: string; name?: string; url?: string; token?: string; model?: string; contextWindow?: number; execution?: string; runtimeModel?: string; action?: string; nodeName?: string };
export const dynamic = 'force-dynamic';
export async function GET(request:Request) {
  const rows = await env.DB.prepare("SELECT id,kind,name,config,secret FROM connections WHERE kind IN ('model','embedding','rerank') ORDER BY created_at").all<{ id: string; kind: string; name: string; config: string; secret: string }>();
  const selected = await env.DB.prepare("SELECT value FROM settings WHERE key='inference_model'").first<{ value: string }>();
  const models = await configuredModels(env, actor(request).id);
  if (!isAdmin(actor(request))) return ok({connections:[],models:models.map(({id,name,model,execution,provider,ownerId,homeId,nodeName})=>({id,name,model,execution,provider,homeId,nodeName,personal:!!ownerId})),selected:selected?.value || models[0]?.id || '',gatewayConfigured:!!env.BUZZ_OPENCLAW_URL});
  return ok({ connections: rows.results.filter(row => !JSON.parse(row.config).ownerId && !JSON.parse(row.config).provider).map(row => ({ id: row.id, kind: row.kind, name: row.name, ...JSON.parse(row.config) as ModelConfig, hasToken: !!row.secret })), models: models.map(({ id, name, model, execution, provider, ownerId, homeId, nodeName }) => ({ id, name, model, execution, provider, homeId, nodeName, personal: !!ownerId })), selected: selected?.value ?? models.find(model => !model.provider)?.id ?? '', gatewayConfigured: !!env.BUZZ_OPENCLAW_URL });
}
export async function POST(request: Request) {
  const p = await body<Input>(request);
  if (!p) return fail('Provide connection settings.');
  if (p.id) { const row = await env.DB.prepare('SELECT config FROM connections WHERE id=?').bind(p.id).first<{config:string}>(); if (row && (JSON.parse(row.config).ownerId || JSON.parse(row.config).provider) && p.action !== 'select') return fail('Manage this provider through Habitats → Add models.', 403); }
  if (p.action === 'select') {
    if (!(await configuredModels(env, actor(request).id)).some(model => model.id === p.id && !model.ownerId && !model.provider)) return fail('Choose an existing model.');
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('inference_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(p.id).run();
    return ok({ selected: p.id });
  }
  if (!['model','embedding','rerank'].includes(p.kind || '')) return fail('Choose a connection type.');
  let url: URL;
  try {
    url = new URL(p.url || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return fail('Enter an HTTP(S) API base URL without credentials or query parameters.'); }
  try { await assertEndpoint(env,url.href); } catch(error) { return fail(error instanceof Error?error.message:'Endpoint not allowed.',400); }
  const baseUrl = url.href.replace(/\/$/, '');
  const existing = p.id ? await env.DB.prepare('SELECT kind,secret,config FROM connections WHERE id=?').bind(p.id).first<{ kind: string; secret: string; config: string }>() : null;
  if (p.id && (!existing || existing.kind !== p.kind)) return fail('Connection not found.', 404);
  try {
    const token = typeof p.token === 'string' ? p.token.trim() : existing ? await unseal(env, existing.secret) : '';
    if (token.length > 8192 || /[\r\n]/.test(token)) return fail('Invalid API key.');
    if (p.action === 'discover' || p.action === 'test') {
      const found = await probeModels(baseUrl, 'models', token);
      if (!found.up) return fail(found.error || 'The endpoint did not return a model list.', 502);
      if (p.action === 'discover') return ok(found);
      if (!p.model || !found.models.includes(p.model)) return fail('Choose a model advertised by this endpoint.');
      if (p.kind === 'model') return ok({...found, ...await testModel({id:p.id || '', name:p.name || p.model, url:baseUrl, model:p.model, token, contextWindow:Number(p.contextWindow || 32768), execution:'vllm'})});
      const endpoint = p.kind === 'embedding' ? 'embeddings' : 'rerank';
      const payload = p.kind === 'embedding' ? { model: p.model, input: ['connection test'] } : { model: p.model, query: 'test', documents: ['connection test'] };
      const started = Date.now();
      const response = await modelFetch(`${baseUrl}/${endpoint}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) }, undefined);
      const data = await response.json().catch(() => null) as { data?: { embedding?: number[] }[]; results?: unknown[] } | null;
      if (!response.ok) return fail(`The model request failed (HTTP ${response.status}). Check the served model, chat template, and API key.`, 502);
      const valid = p.kind === 'embedding' ? Array.isArray(data?.data?.[0]?.embedding) : Array.isArray(data?.results);
      if (!valid) return fail('The endpoint returned an unsupported response.', 502);
      return ok({ ...found, latencyMs: Date.now() - started, message: 'Request succeeded.' });
    }
    if (p.id && await env.DB.prepare("SELECT id FROM runs WHERE connection_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(p.id).first()) return fail('Wait for active runs before editing this connection.', 409);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || typeof p.model !== 'string' || !p.model.trim() || p.model.length > 300) return fail('Enter a connection name and served model ID.');
    const contextWindow = Number(p.contextWindow || 32768);
    if (!Number.isInteger(contextWindow) || contextWindow < 2048 || contextWindow > 2000000) return fail('Context window must be between 2,048 and 2,000,000 tokens.');
    if (p.execution && !['vllm','openclaw'].includes(p.execution)) return fail('Choose chat or agent execution.');
    if (p.runtimeModel && !/^[\w./:-]{1,300}$/.test(p.runtimeModel)) return fail('Enter the runtime provider/model ID.');
    const connectionId = p.id || id('conn');
    if (p.nodeName !== undefined && (typeof p.nodeName !== 'string' || p.nodeName.length > 80)) return fail('Use a machine name of at most 80 characters.');
    const priorConfig = existing ? JSON.parse(existing.config) as ModelConfig : null;
    const config: ModelConfig = { homeId: priorConfig?.url === baseUrl ? priorConfig.homeId || 'lab' : localHomeId(baseUrl), nodeName: p.nodeName?.trim() || (localHomeId(baseUrl) === 'lab' ? 'This computer' : url.hostname), url: baseUrl, model: p.model.trim(), contextWindow, execution: p.execution === 'openclaw' ? 'openclaw' : 'vllm', runtimeModel: p.runtimeModel?.trim() || (p.execution === 'openclaw' ? `shoal-${connectionId}/${p.model.trim()}` : undefined) };
    const secret = await seal(env, token);
    if (p.kind !== 'model') {
      const other = await env.DB.prepare('SELECT id FROM connections WHERE kind=? AND id<>?').bind(p.kind, connectionId).first();
      if (other) return fail('Edit or remove the existing retrieval connection first.', 409);
    }
    await env.DB.prepare('INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,secret=excluded.secret').bind(connectionId, p.kind, p.name.trim(), JSON.stringify(config), secret, now()).run();
    return ok({ id: connectionId });
  } catch (error) { return fail(error instanceof Error ? error.message : 'Could not complete the connection request. Check the endpoint and server secret configuration.', 502); }
}
export async function DELETE(request: Request) {
  const connectionId = new URL(request.url).searchParams.get('id');
  if (!connectionId) return fail('Choose a connection.');
  const row = await env.DB.prepare('SELECT config FROM connections WHERE id=?').bind(connectionId).first<{config:string}>();
  if (row && (JSON.parse(row.config).ownerId || JSON.parse(row.config).provider)) return fail('Manage this provider through Habitats → Add models.', 403);
  const active = await env.DB.prepare("SELECT id FROM runs WHERE connection_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(connectionId).first();
  if (active) return fail('Wait for this connection’s active runs before removing it.', 409);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM connections WHERE id=? AND kind IN ('model','embedding','rerank')").bind(connectionId),
    env.DB.prepare("DELETE FROM settings WHERE key='inference_model' AND value=?").bind(connectionId),
  ]);
  return ok({ ok: true });
}
