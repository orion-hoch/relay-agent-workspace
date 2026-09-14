import { actor, isAdmin } from '@/lib/server/team';
import { canReadRun, canUseAgent, publicRun } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { textValue, body, emit, fail, id, mapRun, now, ok } from '@/lib/buzz/db';
import { selectedModel } from '@/lib/buzz/models';
import { getAgent } from '@/lib/buzz/context';
import { canUseContextRoom, resolveContextRoom } from '@/lib/buzz/context-scope';
import type { RunMode } from '@/lib/buzz/types';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get('id');
  if (!runId) return fail('Missing run id.');
  const row = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, unknown>>();
  if (!row || !await canReadRun(env,actor(request),runId)) return fail('Run not found.', 404);
  const events = await env.DB.prepare('SELECT id, type, payload, ts FROM run_events WHERE run_id = ? ORDER BY id').bind(runId).all<{ id: number; type: string; payload: string; ts: string }>();
  return ok({ run: publicRun(mapRun(row,true),actor(request).id), events: events.results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) });
}
export async function POST(request: Request) {
  const p = await body<{ retryRunId?: string; mode?: RunMode }>(request);
  if (p?.mode && !['quick', 'deep'].includes(p.mode)) return fail('Choose Quick or Deep.');
  const prior = p?.retryRunId ? await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(p.retryRunId).first<Record<string, unknown>>() : null;
  if (!prior || !await canReadRun(env, actor(request), String(prior.id))) return fail('Original run not found.', 404);
  if (!['failed', 'cancelled', 'completed', 'paused', 'needs_input'].includes(String(prior.status))) return fail('This run is still active.', 409);
  if (prior.status === 'completed' && p?.mode !== 'deep') return fail('Completed runs can continue with Go deeper.', 409);
  const agent = await getAgent(env, String(prior.agent_id));
  if (!agent || !canUseAgent(actor(request), agent)) return fail('The original agent is no longer available.', 404);
  const scopeRoom = prior.room ? await resolveContextRoom(env, textValue(prior.room)).catch(() => null) : null;
  if (prior.room && !scopeRoom) return fail('Original conversation not found.', 404);
  if (!await canUseContextRoom(env, agent, scopeRoom)) return fail(`${agent.name} no longer has access to this conversation.`, 403);
  const active = await env.DB.prepare("SELECT id FROM runs WHERE trigger_message_id = ? AND agent_id = ? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(prior.trigger_message_id, agent.id).first();
  if (active) return fail('This request already has a run in progress.', 409);
  const mode = p?.mode ?? (prior.mode === 'deep' ? 'deep' : 'quick');
  let inference;
  try { inference = await selectedModel(env, agent.id, actor(request).id); } catch (error) { return fail(error instanceof Error ? error.message : 'Choose a model connection.', 409); }
  if (!isAdmin(actor(request)) && inference.execution==='openclaw') return fail('Native tool runtimes require an admin. Use a vLLM chat agent for team access.',403);
  const runId = id('run'); const ts = now(); const replyId = prior.room ? id('msg') : null;
  const stmts = [env.DB.prepare("INSERT INTO runs(id, task_id, kind, agent_id, room, message_id, trigger_message_id, parent_run_id, status, backend, mode, model, connection_id, created_at, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)")
    .bind(runId, prior.task_id ?? null, String(prior.kind), agent.id, prior.room ?? null, replyId, prior.trigger_message_id ?? null, String(prior.id), inference.execution, mode, inference.model, inference.id, ts, actor(request).id)];
  if (replyId) stmts.push(env.DB.prepare("INSERT INTO messages(id,room,member_id,name,body,created_at,run_id,state) VALUES (?,?,?,?,'',?,?,'pending')").bind(replyId, prior.room, agent.id, agent.name, ts, runId));
  try { await env.DB.batch(stmts); } catch { return fail('This request already has a run in progress.', 409); }
  const run = mapRun((await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, unknown>>())!);
  if (replyId) await emit(env, 'message.created', { message: { id: replyId, room: prior.room, memberId: agent.id, name: agent.name, body: '', createdAt: ts, runId, state: 'pending' } });
  await emit(env, 'run.queued', { run });
  return ok({ run: publicRun(run, actor(request).id) });
}
