import { actor, isAdmin } from '@/lib/server/team';
import { canonicalRoom, canUseAgent, publicRoom } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, emit, fail, id, mapMember, mapMessage, mapRun, now, ok } from '@/lib/buzz/db';
import { selectedModel } from '@/lib/buzz/models';
import type { MemberRecord, RunMode } from '@/lib/buzz/types';
import { canUseContextRoom, dmMembers, resolveContextRoom } from '@/lib/buzz/context-scope';
export const dynamic = 'force-dynamic';

function mentioned(text: string, name: string): boolean {
  return text.toLowerCase().split(`@${name.toLowerCase()}`).slice(1).some((tail) => !tail || /^[\s.,!?;:]/.test(tail));
}
export async function POST(request: Request) {
  const p = await body<{ room?: string; text?: string; clientId?: string; mode?: RunMode }>(request);
  const user=actor(request);
  const text = String(p?.text ?? '').trim(); const requestedRoom = String(p?.room ?? '').trim();
  const room=await canonicalRoom(env,user,requestedRoom);
  if (!room) return fail('Conversation not found or access denied.',404);
  if (!text || text.length > 30000 || room.length > 160) return fail('Write a message of at most 30,000 characters.');
  if (p?.mode && !['quick', 'deep'].includes(p.mode)) return fail('Choose Quick or Deep.');
  const mode = p?.mode ?? 'quick';
  const memberId = user.id;
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first<Record<string, unknown>>();
  const clientId = user.id+':'+(typeof p?.clientId === 'string' ? p.clientId.slice(0, 80) : id('client'));
  const existing = await env.DB.prepare('SELECT * FROM messages WHERE client_id = ?').bind(clientId).first<Record<string, unknown>>();
  if (existing) {
    const runs = await env.DB.prepare('SELECT id FROM runs WHERE trigger_message_id = ?').bind(existing.id).all<{ id: string }>();
    return ok({ message: { ...mapMessage(existing),room:publicRoom(String(existing.room),user.id) }, runs: runs.results.map((r) => r.id) });
  }
  const rows = await env.DB.prepare("SELECT * FROM members WHERE kind = 'agent'").all<Record<string, unknown>>();
  const scopeRoom = await resolveContextRoom(env, room).catch(() => null);
  if (!scopeRoom) return fail('Conversation thread not found.', 404);
  const available = rows.results.map(mapMember).filter((a: MemberRecord) => canUseAgent(user,a));
  const directMembers = scopeRoom.startsWith('dm:') ? dmMembers(scopeRoom) : null;
  const explicit = available.filter(agent => directMembers ? directMembers.includes(agent.id) : mentioned(text, agent.name));
  const authorized = await Promise.all(available.map(async agent => ({ agent, allowed: await canUseContextRoom(env, agent, scopeRoom) })));
  const agents = mode === 'deep' && !explicit.length && !scopeRoom.startsWith('dm:')
    ? authorized.filter(item => item.allowed).map(item => item.agent) : explicit;
  if (mode === 'deep' && !agents.length) return fail('Mention an available agent to start a deep dive here.');
  const denied = agents.filter(agent => !authorized.find(item => item.agent.id === agent.id)?.allowed);
  if (denied.length) return fail(`${denied.map(agent => agent.name).join(', ')} cannot access this conversation. Use an authorized room or send an explicitly scoped direct message.`, 403);
  let choices;
  try { choices = await Promise.all(agents.map(agent => selectedModel(env, agent.id, user.id))); }
  catch (error) { return fail(error instanceof Error ? error.message : 'Choose a model connection.', 409); }
  if (!isAdmin(user) && choices.some(model=>model.execution==='openclaw')) return fail('Native tool runtimes are restricted to admins in this release. Ask an admin for a vLLM chat agent.',403);
  const ts = now(); const replyAt = new Date(Date.parse(ts) + 1).toISOString(); const triggerId = id('msg');
  const pending = agents.map((a, index) => ({ agent: a, inference: choices[index], replyId: id('msg'), runId: id('run') }));
  const stmts = [env.DB.prepare('INSERT INTO messages(id, room, member_id, name, body, created_at, state, client_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)').bind(triggerId, room, memberId, (typeof member?.name === 'string' && member.name ? member.name : 'You'), text, ts, clientId)];
  if (!room.startsWith('dm:') && !room.startsWith('thread:')) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO channels(name, created_at) VALUES (?, ?)').bind(room, ts));
  for (const { agent, replyId, runId, inference } of pending) stmts.push(
    env.DB.prepare("INSERT INTO messages(id, room, member_id, name, body, created_at, run_id, state) VALUES (?, ?, ?, ?, '', ?, ?, 'pending')").bind(replyId, room, agent.id, agent.name, replyAt, runId),
    env.DB.prepare("INSERT INTO runs(id, kind, agent_id, room, message_id, trigger_message_id, status, backend, mode, model, connection_id, created_at, requested_by) VALUES (?, 'chat', ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)").bind(runId, agent.id, room, replyId, triggerId, inference.execution, mode, inference.model, inference.id, ts, user.id),
  );
  try { await env.DB.batch(stmts); } catch (error) {
    const duplicate = await env.DB.prepare('SELECT * FROM messages WHERE client_id = ?').bind(clientId).first<Record<string, unknown>>();
    if (duplicate) return ok({ message: { ...mapMessage(duplicate),room:publicRoom(String(duplicate.room),user.id) }, runs: [] });
    throw error;
  }
  const message = { id: triggerId, room, memberId, name: (typeof member?.name === 'string' && member.name ? member.name : 'You'), body: text, createdAt: ts, state: null };
  await emit(env, 'message.created', { message });
  for (const { agent, replyId, runId } of pending) {
    await emit(env, 'message.created', { message: { id: replyId, room, memberId: agent.id, name: agent.name, body: '', createdAt: replyAt, runId, state: 'pending' } });
    await emit(env, 'run.queued', { run: mapRun((await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, unknown>>())!) });
  }
  return ok({ message:{...message,room:publicRoom(room,user.id)}, runs: pending.map((p) => p.runId) });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams, user = actor(request);
  const room = await canonicalRoom(env, user, params.get('room') || '', false);
  if (!room) return fail('Conversation not found.', 404);
  const messageId=params.get('id');
  if(messageId){const row=await env.DB.prepare('SELECT * FROM messages WHERE id=? AND room=?').bind(messageId,room).first<Record<string,unknown>>();return ok({messages:row?[{...mapMessage(row),room:publicRoom(room,user.id)}]:[],hasMore:false});}
  const before = params.get('before');
  const cursor = before ? await env.DB.prepare('SELECT id,created_at FROM messages WHERE id=? AND room=?').bind(before, room).first<{ id: string; created_at: string }>() : null;
  if (before && !cursor) return fail('History cursor not found in this conversation.', 400);
  if (params.get('check') === '1') {
    const older = cursor ? await env.DB.prepare('SELECT id FROM messages WHERE room=? AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1')
      .bind(room, cursor.created_at, cursor.created_at, cursor.id).first() : null;
    return ok({hasMore: !!older});
  }
  const rows = await env.DB.prepare(`SELECT * FROM messages WHERE room=? ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC, id DESC LIMIT 51`)
    .bind(room, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : [])).all<Record<string, unknown>>();
  return ok({ messages: rows.results.slice(0, 50).reverse().map(row => ({ ...mapMessage(row), room: publicRoom(room, user.id) })), hasMore: rows.results.length > 50 });
}
