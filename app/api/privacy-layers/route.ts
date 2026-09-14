import { env } from '@/lib/server/env';
import { actor, isAdmin } from '@/lib/server/team';
import { loadPrivacyLayers } from '@/lib/server/privacy-layers';
import { body, emit, fail, ok } from '@/lib/buzz/db';
import { LEVELS, type Level } from '@/lib/buzz/types';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isAdmin(actor(request))) return fail('Only workspace admins can manage privacy layers.', 403);
  const input = await body<{ action?: 'create' | 'update'; name?: string; clearance?: Level; localOnly?: boolean }>(request);
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 48 || Array.from(name).some(char => char.charCodeAt(0) < 32)) return fail('Use a layer name of 1–48 characters.');
  if (LEVELS.some(level => level.toLowerCase() === name.toLowerCase())) return fail('Built-in layers cannot be changed. Choose a new name.');
  if (!input?.clearance || !LEVELS.includes(input.clearance) || typeof input.localOnly !== 'boolean') return fail('Choose a clearance and processing policy.');
  if (['Confidential', 'Restricted'].includes(input.clearance) && !input.localOnly) return fail('Confidential and Restricted layers must stay local.');
  const key = `privacy-layer:${name.toLowerCase()}`;
  const existing = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>();
  if (existing && JSON.parse(existing.value).name !== name) return fail('A layer with that name already exists. Use its existing spelling.');
  if (existing && input.action !== 'update') return fail('A layer with that name already exists. Edit the existing layer.', 409);
  if (!existing && input.action === 'update') return fail('Layer not found.', 404);
  const layer = { name, clearance: input.clearance, localOnly: input.localOnly };
  const saved = existing
    ? await env.DB.prepare('UPDATE settings SET value=? WHERE key=? AND value=? RETURNING key').bind(JSON.stringify(layer), key, existing.value).first()
    : await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING RETURNING key').bind(key, JSON.stringify(layer)).first();
  if (!saved) return fail('This layer changed in another session. Reload and try again.', 409);
  await emit(env, 'workspace.updated', { key: 'privacyLayers' });
  return ok({ layers: await loadPrivacyLayers(env) });
}

export async function DELETE(request: Request) {
  if (!isAdmin(actor(request))) return fail('Only workspace admins can manage classifications.', 403);
  const input = await body<{name?: string; replacement?: string}>(request);
  const layers = await loadPrivacyLayers(env);
  const layer = layers.find(item => item.name === input?.name);
  if (!layer) return fail('Classification not found.', 404);
  if (LEVELS.includes(layer.name as Level)) return fail('Built-in classifications cannot be deleted.');
  const replacement = layers.find(item => item.name === input?.replacement && item.name !== layer.name);
  if (!replacement || LEVELS.indexOf(replacement.clearance) < LEVELS.indexOf(layer.clearance) || (layer.localOnly && !replacement.localOnly)) return fail('Choose a replacement with the same or stronger privacy.');
  const pending = await env.DB.prepare("SELECT id FROM documents WHERE pending_source IS NOT NULL AND (level=? OR json_extract(pending_source,'$.level')=?) LIMIT 1").bind(layer.name, layer.name).first();
  if (pending) return fail('A source refresh uses this classification. Finish or cancel the refresh, then delete it.', 409);
  const agents = await env.DB.prepare("SELECT id,data FROM members WHERE json_extract(data,'$.accessLevel')=?").bind(layer.name).all<{id:string;data:string}>();
  await env.DB.batch([
    env.DB.prepare('UPDATE documents SET level=? WHERE level=?').bind(replacement.name, layer.name),
    env.DB.prepare('UPDATE channels SET level=? WHERE level=?').bind(replacement.name, layer.name),
    // Preserve the agent's existing clearance; a stricter file replacement must not grant it more access.
    ...agents.results.map(agent => env.DB.prepare('UPDATE members SET data=? WHERE id=? AND data=?').bind(JSON.stringify({...JSON.parse(agent.data), accessLevel:layer.clearance}),agent.id,agent.data)),
    env.DB.prepare('DELETE FROM settings WHERE key=?').bind(`privacy-layer:${layer.name.toLowerCase()}`),
  ]);
  await emit(env, 'workspace.updated', {key:'privacyLayers'});
  return ok({layers:await loadPrivacyLayers(env)});
}
