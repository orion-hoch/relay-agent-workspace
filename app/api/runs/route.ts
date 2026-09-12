import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, emit, ensureSchema, fail, id, mapRun, mapTask, now, ok, sameOrigin } from '@/lib/buzz/db';
import { getAgent } from '@/lib/buzz/context';
import { canUseContextRoom, canUseTaskContext, resolveContextRoom } from '@/lib/buzz/context-scope';
import type { RunMode } from '@/lib/buzz/types';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const e = env as unknown as BuzzEnv; await ensureSchema(e);
  const runId = new URL(request.url).searchParams.get('id');
  if (!runId) return fail('Missing run id.');
  const row = await e.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, unknown>>();
  if (!row) return fail('Run not found.', 404);
  const events = await e.DB.prepare('SELECT id, type, payload, ts FROM run_events WHERE run_id = ? ORDER BY id').bind(runId).all<{ id: number; type: string; payload: string; ts: string }>();
  return ok({ run: mapRun(row, true), events: events.results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) });
}
export async function POST(request: Request) {
  const e = env as unknown as BuzzEnv;
  if (!sameOrigin(request)) return fail('Forbidden', 403);
  await ensureSchema(e);
  const p = await body<{ taskId?: string; agentId?: string; retryRunId?: string; mode?: RunMode }>(request);
  if (p?.mode && !['quick', 'deep'].includes(p.mode)) return fail('Choose Quick or Deep.');
  const prior = p?.retryRunId ? await e.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(p.retryRunId).first<Record<string, unknown>>() : null;
  if (p?.retryRunId && !prior) return fail('Original run not found.', 404);
  if (prior && !['failed', 'cancelled', 'completed'].includes(String(prior.status))) return fail('This run is still active.', 409);
  if (prior?.status === 'completed' && p?.mode !== 'deep') return fail('Completed runs can continue with Go deeper.', 409);
  const taskId = p?.taskId || (prior?.task_id ? String(prior.task_id) : null);
  const agentId = prior ? String(prior.agent_id) : p?.agentId;
  const agent = agentId ? await getAgent(e, agentId) : null;
  const taskRow = taskId ? await e.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Record<string, unknown>>() : null;
  if (!agent || (!taskRow && !prior)) return fail('Choose a task and an agent.', 404);
  if (!canUseTaskContext(agent, taskId)) return fail(`${agent.name} is not granted this Shell task's stored context.`, 403);
  const scopeRoom = prior?.room ? await resolveContextRoom(e, String(prior.room)).catch(() => null) : null;
  if (prior?.room && !scopeRoom) return fail('Original conversation not found.', 404);
  if (!canUseContextRoom(agent, scopeRoom)) return fail(`${agent.name} no longer has access to this conversation.`, 403);
  const active = taskId
    ? await e.DB.prepare("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(taskId).first()
    : await e.DB.prepare("SELECT id FROM runs WHERE trigger_message_id = ? AND agent_id = ? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(prior!.trigger_message_id, agent.id).first();
  if (active) return fail('This task already has a run in progress.', 409);
  const mode = p?.mode ?? (prior?.mode === 'deep' ? 'deep' : prior ? 'quick' : 'deep');
  const runId = id('run'); const ts = now(); const replyId = prior?.room ? id('msg') : null;
  const stmts = [e.DB.prepare("INSERT INTO runs(id, kind, agent_id, task_id, room, message_id, trigger_message_id, parent_run_id, status, backend, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'openclaw', ?, ?)")
    .bind(runId, prior?.kind ?? 'task', agent.id, taskId, prior?.room ?? null, replyId, prior?.trigger_message_id ?? null, prior?.id ?? null, mode, ts)];
  if (replyId) stmts.push(e.DB.prepare("INSERT INTO messages(id,room,member_id,name,body,created_at,run_id,state) VALUES (?,?,?,?,'',?,?,'pending')").bind(replyId, prior!.room, agent.id, agent.name, ts, runId));
  if (taskId) stmts.push(e.DB.prepare("UPDATE tasks SET status = 'In progress', owner = CASE WHEN owner = '' THEN ? ELSE owner END WHERE id = ?").bind(agent.name, taskId));
  await e.DB.batch(stmts);
  const run = mapRun((await e.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, unknown>>())!);
  if (replyId) await emit(e, 'message.created', { message: { id: replyId, room: prior!.room, memberId: agent.id, name: agent.name, body: '', createdAt: ts, runId, state: 'pending' } });
  const task = taskId ? mapTask((await e.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Record<string, unknown>>())!) : null;
  await emit(e, 'run.queued', { run }); if (task) await emit(e, 'task.updated', { task });
  return ok({ run, task });
}
