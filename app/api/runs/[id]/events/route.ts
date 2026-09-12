import { nativeChildRun } from '@/lib/buzz/native-child';
import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, ensureSchema, fail, mapRun, now, ok, runnerAuthorized } from '@/lib/buzz/db';
import { leaseUntil } from '@/lib/buzz/runs';
export const dynamic = 'force-dynamic';
type Ev = { type: 'delta' | 'done' | 'failed' | 'tool' | 'heartbeat'; runnerId?: string; attempt?: number; seq?: number; text?: string; result?: string; error?: string; inputTokens?: number; outputTokens?: number; name?: string; input?: unknown; output?: unknown };
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> | { id: string } }) {
  const e = env as unknown as BuzzEnv;
  if (!runnerAuthorized(request, e)) return fail('Runner token required.', 401);
  await ensureSchema(e); const { id } = await ctx.params;
  const ev = await body<Ev>(request);
  const row = await e.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row || !ev) return fail('Run or event missing.', 404);
  if (row.runner_id !== ev.runnerId || Number(row.attempt) !== ev.attempt) return fail('This runner no longer owns the attempt.', 409);
  if (ev.type === 'heartbeat') {
    const changed = await e.DB.prepare("UPDATE runs SET lease_until=? WHERE id=? AND runner_id=? AND attempt=? AND status IN ('running','awaiting')").bind(leaseUntil(), id, ev.runnerId, ev.attempt).run();
    return changed.meta.changes ? ok({ ok: true }) : fail('Run is no longer active.', 409);
  }
  if (!Number.isInteger(ev.seq) || Number(ev.seq) < 1) return fail('Event sequence required.');
  if (Number(ev.seq) <= Number(row.last_seq)) return ok({ ok: true, duplicate: true });
  if (ev.seq !== Number(row.last_seq) + 1) return fail('Event sequence gap.', 409);
  if (!['running','awaiting'].includes(String(row.status))) return fail('Run is no longer active.', 409);
  if (!['delta','done','failed','tool'].includes(ev.type)) return fail('Unknown event type.');
  if (ev.type === 'done') {
    const waiting = await e.DB.prepare("SELECT id FROM approvals WHERE run_id=? AND receipt IS NULL LIMIT 1").bind(id).first();
    if (waiting) return fail('An action is still waiting for a native approval receipt.', 409);
  }
  const ts = now(); const run = mapRun(row);
  const guard = "EXISTS(SELECT 1 FROM runs WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting'))";
  const params = [id, ev.attempt!, Number(row.last_seq)];
  const statements: D1PreparedStatement[] = [];
  const event = (type: string, payload: Record<string, unknown>) => statements.push(e.DB.prepare(`INSERT INTO events(ts,type,payload) SELECT ?,?,? WHERE ${guard}`).bind(ts, type, JSON.stringify(payload), ...params));
  if (ev.type === 'delta') {
    const text = String(ev.text ?? '');
    if (text.length > 100000) return fail('Delta is too large.');
    statements.push(e.DB.prepare(`UPDATE messages SET body=body||? WHERE id=? AND ${guard}`).bind(text, run.messageId, ...params));
    event('run.delta', { runId: id, messageId: run.messageId, text });
  } else if (ev.type === 'tool') {
    statements.push(e.DB.prepare(`INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'tool',?,? WHERE ${guard}`).bind(id, JSON.stringify({ name: ev.name, input: ev.input, output: ev.output }), ts, ...params));
    event('run.tool', { runId: id, name: ev.name });
    if (ev.name === 'native.agent') { const child = nativeChildRun(run, ev.output); if (child) event('run.updated', { run: child }); }
  } else {
    const completed = ev.type === 'done'; const status = completed ? 'completed' : 'failed';
    const result = completed ? String(ev.result ?? '') : String(ev.result ?? row.result ?? '');
    const error = completed ? null : String(ev.error || 'Execution was interrupted.');
    if (run.messageId) {
      statements.push(e.DB.prepare(`UPDATE messages SET body=CASE WHEN ? THEN ? ELSE body END,state=?,error=? WHERE id=? AND ${guard}`).bind(completed ? 1 : 0, result, completed ? 'complete' : 'error', error, run.messageId, ...params));
      const message = await e.DB.prepare('SELECT * FROM messages WHERE id=?').bind(run.messageId).first<Record<string, unknown>>();
      if (message) event('message.updated', { message: { id: message.id, room: message.room, memberId: message.member_id, name: message.name, body: completed ? result : message.body, createdAt: message.created_at, runId: id, state: completed ? 'complete' : 'error', error } });
    }
    if (run.taskId) {
      statements.push(e.DB.prepare(`UPDATE tasks SET comments=json_insert(comments,'$[#]',?),deliverable=CASE WHEN ? THEN ? ELSE deliverable END,status=CASE WHEN ? THEN 'In review' ELSE status END WHERE id=? AND ${guard}`)
        .bind(completed ? `Run ${id} completed; result attached.` : `Run ${id} failed: ${error}`, completed ? 1 : 0, result, completed ? 1 : 0, run.taskId, ...params));
      // The store reloads the authoritative task when it sees this event.
      event('task.refresh', { taskId: run.taskId });
    }
    event(completed ? 'run.completed' : 'run.failed', { run: { ...run, status, result, error, endedAt: ts, inputTokens: ev.inputTokens ?? run.inputTokens, outputTokens: ev.outputTokens ?? run.outputTokens }, runId: id, error });
    statements.push(e.DB.prepare(`UPDATE runs SET status=?,result=?,error=?,input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens),ended_at=?,lease_until=NULL,last_seq=? WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting')`)
      .bind(status, result, error, ev.inputTokens ?? null, ev.outputTokens ?? null, ts, ev.seq, id, ev.attempt, row.last_seq));
  }
  if (ev.type === 'delta' || ev.type === 'tool') statements.push(e.DB.prepare("UPDATE runs SET last_seq=?,lease_until=? WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting')").bind(ev.seq, leaseUntil(), id, ev.attempt, row.last_seq));
  // D1 batches are atomic: the sequence advances after all conditionally guarded writes.
  await e.DB.batch(statements);
  return ok({ ok: true });
}
