import { env } from '@/lib/server/env';
import { actor, audit, isAdmin, getConfig } from '@/lib/server/team';
import { body, fail, id, now, ok } from '@/lib/buzz/db';
import { configuredModels, probeModels, testModel, type LocalModel } from '@/lib/buzz/models';
import { assertCloudAccess } from '@/lib/server/network';
import { seal } from '@/lib/buzz/secrets';
import { CLOUD_PROVIDERS } from '@/lib/cloud-providers.mjs';
import { googleConfiguration, googleConnection } from '@/lib/server/google-drive';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = actor(request), config = await getConfig();
  const models = (await configuredModels(env, user.id)).filter(model => model.provider);
  const google = await googleConfiguration(), drive = await googleConnection(user.id);
  return ok({ admin: isAdmin(user), enabled: !!config && config.networkMode !== 'lan',
    defaultId: (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('cloud:' + user.id).first<{value:string}>())?.value || '',
    connections: models.map(({id, name, model, provider, ownerId}) => ({id, name, model, provider, shared: !ownerId})),
    google: { configured: !!google, connected: !!drive, email: drive?.config.email || '', ...(isAdmin(user) ? { clientId: google?.clientId || '', redirectUri: google?.redirectUri || '' } : {}) } });
}
export async function POST(request: Request) {
  const user = actor(request), p = await body<{ action?: string; id?: string; provider?: string; token?: string; model?: string; name?: string; shared?: boolean; copy?: boolean; clientId?: string; clientSecret?: string; redirectUri?: string }>(request);
  if (!p) return fail('Enter connection settings.');
  if (p.copy !== undefined && typeof p.copy !== 'boolean') return fail('Invalid copy request.');
  if (p.shared !== undefined && typeof p.shared !== 'boolean') return fail('Choose personal or shared credentials.');
  if (user.role === 'viewer') return fail('Viewers cannot configure integrations.', 403);
  try {
    if (p.action === 'googleConfig') {
      if (!isAdmin(user)) return fail('Only an admin can configure Google sign-in.', 403);
      const prior = await googleConfiguration();
      const clientId = p.clientId?.trim(), clientSecret = p.clientSecret?.trim() || prior?.clientSecret;
      let redirect: URL;
      try { redirect = new URL(p.redirectUri || ''); } catch { return fail('Enter the Google callback URL.'); }
      if (!clientId || clientId.length > 500 || !clientSecret || clientSecret.length > 2000 || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/api/integrations/google/callback' || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname)))) return fail('Use a Google web client and an HTTPS callback (HTTP localhost is supported for development).');
      const secret = await seal(env, JSON.stringify({ clientId, clientSecret, redirectUri: redirect.href }));
      await env.DB.prepare("INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES ('google-oauth','google_oauth','Google sign-in','{}',?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret").bind(secret, now()).run();
      await audit(user.id, 'google.configured', {});
      return ok({message: 'Google sign-in configured. Each teammate connects their own Drive account.'});
    }
    await assertCloudAccess(env);
    const existing = p.id ? (await configuredModels(env, user.id)).find(model => model.id === p.id && model.provider) : null;
    if (p.id && !existing) return fail('Connection not found.', 404);
    if (existing && !existing.ownerId && !isAdmin(user) && !['test', 'default'].includes(p.action || '')) return fail('Only an admin can edit shared connections.', 403);
    if (p.action === 'default') {
      if (!existing) return fail('Choose a connection.');
      await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('cloud:' + user.id, existing.id).run();
      return ok({ message: 'Your cloud agents will use this connection unless you select another model in the conversation.' });
    }
    const provider = (existing?.provider || p.provider) as keyof typeof CLOUD_PROVIDERS;
    if (!Object.hasOwn(CLOUD_PROVIDERS, provider)) return fail('Choose a supported provider.');
    const preset = CLOUD_PROVIDERS[provider];
    const token = p.token === undefined ? existing?.token || '' : p.token.trim();
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) return fail('Enter a valid provider API key.');
    const model = (p.model || existing?.model || '').trim();
    const connection: LocalModel = { id: p.copy ? id('conn') : existing?.id || id('conn'), name: p.name?.trim() || existing?.name || model.slice(0,80) || preset.name, url: preset.url, provider, model, contextWindow: 32768, execution: 'vllm', token };
    if (p.action === 'test') return ok(await testModel(connection));
    if (!['save', 'discover'].includes(p.action || '')) return fail('Choose discover, test, save, or default.');
    const observed = await probeModels(preset.url, provider === 'anthropic' ? 'models?limit=1000' : 'models', token, provider);
    if (!observed.up) return fail(observed.error || 'Provider authentication failed.', 502);
    if (p.action === 'discover') return ok({ models: observed.models, message: 'Authenticated. Choose an available model.' });
    if (!model || model.length > 300 || !observed.models.includes(model) || connection.name.length > 80) return fail('Choose a model available to this API key and a name of at most 80 characters.');
    if (p.shared && !isAdmin(user)) return fail('Only an admin can add shared workspace credentials.', 403);
    if (existing && !p.copy && await env.DB.prepare("SELECT id FROM runs WHERE connection_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(existing.id).first()) return fail('Wait for active runs before editing this connection.', 409);
    await testModel(connection);
    const shared = p.shared === undefined ? !!existing && !existing.ownerId : p.shared;
    const config = { url: preset.url, model, contextWindow: 32768, execution: 'vllm', provider, ownerId: shared ? '' : user.id, createdBy: user.id };
    await env.DB.prepare('INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,secret=excluded.secret').bind(connection.id, 'model', connection.name, JSON.stringify(config), await seal(env, token), now()).run();
    await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind('cloud:' + user.id, connection.id).run();
    if (shared) {
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('cloud_model',?) ON CONFLICT(key) DO NOTHING").bind(connection.id).run();
    }
    await audit(user.id, 'model.connected', { id: connection.id, provider, shared });
    return ok({ id: connection.id, message: `${connection.name} connected. ${shared ? 'Available to your team’s cloud agents.' : 'Only your account can use this API key.'}` });
  } catch (error) { return fail(error instanceof Error ? error.message : 'Connection failed.', 400); }
}
export async function DELETE(request: Request) {
  const user = actor(request), connectionId = new URL(request.url).searchParams.get('id');
  const model = (await configuredModels(env, user.id)).find(model => model.id === connectionId && model.provider);
  if (!model) return fail('Connection not found.', 404);
  if (user.role === 'viewer' || (!model.ownerId && !isAdmin(user))) return fail('You cannot remove this connection.', 403);
  if (await env.DB.prepare("SELECT id FROM runs WHERE connection_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(model.id).first()) return fail('Wait for active runs before disconnecting.', 409);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM connections WHERE id=?').bind(model.id),
    env.DB.prepare("DELETE FROM settings WHERE value=? AND (key IN ('cloud_model','inference_model') OR key LIKE 'cloud:%' OR key LIKE 'model:%')").bind(model.id),
  ]);
  await audit(user.id, 'model.disconnected', { id: model.id });
  return ok({ message: 'Disconnected. Existing conversation messages remain.' });
}
