import {actor,isAdmin} from '@/lib/server/team';
import { agentHome, agentHomeId, modelFitsHome } from '@/lib/model-home';
import { configuredModels } from '@/lib/buzz/models';
import { env } from '@/lib/server/env';
import { body, emit, fail, mapMember, ok } from '@/lib/buzz/db';
import { loadPrivacyLayers } from '@/lib/privacy-layers';
export const dynamic = 'force-dynamic';
// Upsert an agent definition. Placement (which node runs it) belongs to a run, not the definition.
export async function POST(request: Request) {
  if(!isAdmin(actor(request)))return fail('Only admins can change agents.',403);
  const p = await body<Record<string, unknown>>(request);
  const id = (typeof p?.id === 'string' ? p.id : '').trim(); const name = (typeof p?.name === 'string' ? p.name : '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || name.length > 60) return fail('An agent needs an id and a name.');
  const { id: _id, name: _name, initials, tone, kind: _kind, ...data } = p as Record<string, unknown>;
  if (typeof data.instructions === 'string' && data.instructions.length > 20000) return fail('Instructions are too long.');
  if (data.networkAccess !== undefined && typeof data.networkAccess !== 'boolean') return fail('Network access must be enabled or disabled.');
  const existing = await env.DB.prepare("SELECT kind, data FROM members WHERE id = ?").bind(id).first<{ kind: string; data: string }>();
  if (existing && existing.kind !== 'agent') return fail('Human profiles cannot be replaced by agents.', 409);
  const duplicate = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND id != ?').bind(name, id).first();
  if (duplicate) return fail('A workspace member already has this name.', 409);
  const previous = existing ? JSON.parse(existing.data) : {};
  const mergedData = { ...previous, ...data, createdAt: previous.createdAt ?? Date.now() };
  if(data.accessLevel!==undefined && !(await loadPrivacyLayers(env)).some(layer=>layer.name===data.accessLevel)) return fail('Choose an existing classification for agent access.');
  const home = agentHomeId(mergedData);
  const models = await configuredModels(env);
  if (mergedData.modelConnection) {
    const model = models.find(model => model.id === mergedData.modelConnection && !model.ownerId);
    if (!model || !modelFitsHome(model, home)) return fail('Choose a shared model from this Agent Home.');
  }
  if (!['lab', 'openai-preview'].includes(home) && !models.some(model => modelFitsHome(model, home))) return fail('Connect this machine in Habitats → Add models before assigning agents to it.');
  mergedData.homeId = home;
  mergedData.runtime = agentHome(mergedData);
  if (data.avatar !== undefined) {
    if (typeof data.avatar !== 'string' || data.avatar.length > 100000) return fail('Use a profile picture under 75 KB after resizing.');
    if (data.avatar) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.avatar);
      if (!match) return fail('Use a PNG, JPEG, or WebP profile picture.');
      const bytes = Buffer.from(match[2], 'base64');
      const valid = match[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
      if (!valid) return fail('This file is not a supported image.');
    }
  }
  await env.DB.prepare("INSERT INTO members(id, kind, name, initials, tone, data) VALUES (?, 'agent', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, initials = excluded.initials, tone = excluded.tone, data = excluded.data")
    .bind(id, name, typeof initials === 'string' ? initials : name.slice(0, 2).toUpperCase(), typeof tone === 'string' ? tone : null, JSON.stringify(mergedData)).run();
  const member = mapMember((await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<Record<string, unknown>>())!);
  await emit(env, 'member.updated', { member });
  return ok({ member });
}

export async function DELETE(request: Request) {
  if(!isAdmin(actor(request)))return fail('Only admins can change agents.',403);
  const id = new URL(request.url).searchParams.get('id');
  const existing = id ? await env.DB.prepare("SELECT id FROM members WHERE id = ? AND kind = 'agent'").bind(id).first() : null;
  if (!existing) return fail('Agent not found.', 404);
  const active = await env.DB.prepare("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(id).first();
  if (active) return fail('Wait for this agent’s current work to finish before deleting it.', 409);
  await env.DB.prepare("DELETE FROM members WHERE id = ? AND kind = 'agent'").bind(id).run();
  await emit(env, 'member.deleted', { id });
  return ok({ ok: true });
}
