import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, emit, ensureSchema, fail, mapRun, mapTask, now, ok, runnerAuthorized } from '@/lib/buzz/db';
import { buildPacket, getAgent } from '@/lib/buzz/context';
import { canUseTaskContext } from '@/lib/buzz/context-scope';
import { failRun, leaseUntil } from '@/lib/buzz/runs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const e = env as unknown as BuzzEnv;
  if (!runnerAuthorized(request, e)) return fail('Runner token required.', 401);
  await ensureSchema(e);
  const p = await body<{ runnerId?: string }>(request);
  if (!p?.runnerId) return fail('Runner identity required.');
  const expired = await e.DB.prepare("UPDATE runs SET status='failed', error='The runner disconnected. Review any completed actions before retrying.', ended_at=?, lease_until=NULL WHERE status IN ('preparing','running','awaiting') AND lease_until < ? RETURNING id").bind(now(), now()).all<{ id: string }>();
  for (const r of expired.results) await failRun(e, r.id, 'The runner disconnected. Review any completed actions before retrying.');
  if (!e.BUZZ_OPENCLAW_URL) return fail('OpenClaw is not configured; agent work will stay queued.', 503);
  const row = await e.DB.prepare("UPDATE runs SET status='preparing', started_at=?, runner_id=?, attempt=attempt+1, last_seq=0, lease_until=? WHERE id=(SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *")
    .bind(now(), p.runnerId.slice(0, 120), leaseUntil()).first<Record<string, unknown>>();
  if (!row) return ok({ run: null });
  const run = mapRun(row);
  try {
    const agent = await getAgent(e, run.agentId);
    if (!agent || agent.data.paused) throw new Error('The requested agent is missing or paused.');
    if (!canUseTaskContext(agent, run.taskId ?? null)) throw new Error(`${agent.name} is not granted this Shell task's stored context.`);
    let objective = ''; let contract: string | null = null;
    if (run.kind === 'chat') {
      const trigger = run.triggerMessageId ? await e.DB.prepare('SELECT body FROM messages WHERE id = ?').bind(run.triggerMessageId).first<{ body: string }>() : null;
      if (!trigger) throw new Error('The original message is missing. Send a new request.');
      objective = trigger.body;
    } else {
      const taskRow = await e.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(run.taskId).first<Record<string, unknown>>();
      if (!taskRow) throw new Error('The task is missing.');
      const task = mapTask(taskRow);
      objective = `Task ${task.id}: ${task.title}\n\n${task.description}`;
      contract = [task.criteria ? `Acceptance criteria:\n${task.criteria}` : '', task.comments.length ? `Discussion:\n${task.comments.slice(-6).map((c) => `- ${c}`).join('\n')}` : '', 'Return the outcome, cited evidence, actual checks and unresolved questions.'].filter(Boolean).join('\n\n');
    }
    if (run.parentRunId) {
      const previous = await e.DB.prepare('SELECT result, error FROM runs WHERE id=?').bind(run.parentRunId).first<{ result?: string; error?: string }>();
      contract = `${contract || ''}\nContinuation of ${run.parentRunId}. Preserve previous work; inspect action receipts before repeating any action.\nPrevious outcome:\n${(previous?.result || previous?.error || 'Interrupted; inspect the existing session.').slice(-8000)}`;
    }
    const runtimeAgent = agent.id === 'nova' ? 'product' : agent.id === 'iris' ? 'support' : (e.BUZZ_OPENCLAW_AGENT || 'main');
    const model = `openclaw/${runtimeAgent}`;
    // OpenClaw adds ~8K tokens of native instructions; leave room for tool results in the 32K model window.
    const budget = run.mode === 'deep' ? 20480 : 8192;
    const sessionRoot = run.taskId ?? run.triggerMessageId ?? run.id;
    const packet = await buildPacket(e, { agent, objective, room: run.room, taskContract: contract, budgetTokens: budget, outputReserve: run.mode === 'deep' ? 4096 : 2048, sessionKey: `shoal:${sessionRoot}:${agent.id}`, backend: 'openclaw', model, mode: run.mode, runId: run.id });
    await e.DB.prepare("UPDATE runs SET status='running', backend='openclaw', model=?, packet=?, estimated_input_tokens=?, lease_until=? WHERE id=? AND attempt=?")
      .bind(model, JSON.stringify(packet), packet.estimatedTokens, leaseUntil(), run.id, run.attempt).run();
    await e.DB.prepare('INSERT INTO run_events(run_id,type,payload,ts) VALUES (?,?,?,?)').bind(run.id, 'context.ready', JSON.stringify({ mode: run.mode, estimatedTokens: packet.estimatedTokens, budgetTokens: budget, evidence: packet.evidence.length, droppedEvidence: packet.droppedEvidence, history: packet.historyMessages, rulesVersion: packet.rulesVersion }), now()).run();
    const updated = mapRun((await e.DB.prepare('SELECT * FROM runs WHERE id=?').bind(run.id).first<Record<string, unknown>>())!);
    await emit(e, 'run.started', { run: updated });
    return ok({ run: updated, packet });
  } catch (error) {
    await failRun(e, run.id, error instanceof Error ? error.message : 'Context assembly failed.');
    return ok({ run: null });
  }
}
