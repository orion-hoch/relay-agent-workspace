import { nativeChildRun } from '@/lib/buzz/native-child';
import { env } from '@/lib/server/env';
import { textValue, body, fail, mapRun, now, ok } from '@/lib/buzz/db';
import { leaseUntil, rejectPendingApprovals } from '@/lib/buzz/runs';
import type { Statement } from '@/lib/server/database';
export const dynamic = 'force-dynamic';
type Ev = { type: 'delta' | 'done' | 'input.requested' | 'checkpoint' | 'failed' | 'tool' | 'heartbeat'; runnerId?: string; attempt?: number; seq?: number; text?: string; result?: string; error?: string; inputTokens?: number; outputTokens?: number; name?: string; input?: unknown; output?: unknown; agentId?:string; collaborationId?:string };
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (request.headers.get('x-shoal-device') !== 'local') return fail('Runner token required.', 401);
  const { id } = await ctx.params;
  const ev = await body<Ev>(request);
  const row = await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row || !ev) return fail('Run or event missing.', 404);
  if (row.runner_id !== ev.runnerId || Number(row.attempt) !== ev.attempt) return fail('This runner no longer owns the attempt.', 409);
  if (row.lease_until && textValue(row.lease_until) < now()) return fail('This attempt’s lease has expired.', 409);
  if (ev.type === 'heartbeat') {
    const changed = await env.DB.prepare("UPDATE runs SET lease_until=? WHERE id=? AND runner_id=? AND attempt=? AND status IN ('running','awaiting')").bind(leaseUntil(), id, ev.runnerId, ev.attempt).run();
    return changed.meta.changes ? ok({ ok: true }) : fail('Run is no longer active.', 409);
  }
  if (!Number.isInteger(ev.seq) || Number(ev.seq) < 1) return fail('Event sequence required.');
  if (Number(ev.seq) <= Number(row.last_seq)) return ok({ ok: true, duplicate: true });
  if (ev.seq !== Number(row.last_seq) + 1) return fail('Event sequence gap.', 409);
  if (!['running','awaiting'].includes(String(row.status))) return fail('Run is no longer active.', 409);
  if (!['delta','done','input.requested','checkpoint','failed','tool'].includes(ev.type)) return fail('Unknown event type.');
  if (ev.type === 'done' || ev.type === 'input.requested' || ev.type === 'checkpoint') {
    const waiting = await env.DB.prepare("SELECT id FROM approvals WHERE run_id=? AND receipt IS NULL LIMIT 1").bind(id).first();
    if (waiting) return fail('An action is still waiting for a native approval receipt.', 409);
  }
  const ts = now(); const run = mapRun(row);
  const guard = "EXISTS(SELECT 1 FROM runs WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting'))";
  const params = [id, ev.attempt!, Number(row.last_seq)];
  const statements: Statement[] = [];
  const event = (type: string, payload: Record<string, unknown>) => statements.push(env.DB.prepare(`INSERT INTO events(ts,type,payload) SELECT ?,?,? WHERE ${guard}`).bind(ts, type, JSON.stringify(payload), ...params));
  if (ev.type === 'delta') {
    const text = String(ev.text ?? '');
    if (text.length > 100000) return fail('Delta is too large.');
    statements.push(env.DB.prepare(`UPDATE messages SET body=body||? WHERE id=? AND ${guard}`).bind(text, run.messageId, ...params));
    event('run.delta', { runId: id, messageId: run.messageId, text });
  } else if (ev.type === 'tool') {
    statements.push(env.DB.prepare(`INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'tool',?,? WHERE ${guard}`).bind(id, JSON.stringify({ name: ev.name, input: ev.input, output: ev.output, agentId:ev.agentId, collaborationId:ev.collaborationId }), ts, ...params));
    event('run.tool', { runId: id, name: ev.name });
    if (['native.agent','direct.agent'].includes(ev.name || '')) { const child = nativeChildRun(run, ev.output); if (child) event('run.updated', { run: child }); }
    if(ev.name==='direct.agent' && ev.output && typeof ev.output==='object') {
      const child=ev.output as {nativeRunId?:string;status?:string;result?:string;error?:string};
      if(['completed','failed'].includes(child.status || '')) {
        const grant=await env.DB.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='collaboration.granted' AND json_extract(payload,'$.nativeRunId')=?").bind(id,child.nativeRunId || '').first<{payload:string}>();
        if(grant) {
          const identity=JSON.parse(grant.payload) as {agentId:string;agentName:string};
          const message={id:'msg_'+child.nativeRunId,room:run.room,memberId:identity.agentId,name:identity.agentName,body:child.status==='completed'?String(child.result || ''):`Could not complete this assignment: ${child.error || 'Agent run failed.'}`,createdAt:ts,state:'complete'};
          statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages(id,room,member_id,name,body,created_at,state) SELECT ?,?,?,?,?,?,'complete' WHERE ${guard}`).bind(message.id,message.room,message.memberId,message.name,message.body,ts,...params));
          event('message.created',{message});
        }
      }
    }
  } else {
    const completed = ev.type === 'done' || ev.type === 'input.requested' || ev.type === 'checkpoint';
    const status = ev.type === 'input.requested' ? 'needs_input' : ev.type === 'checkpoint' ? 'paused' : completed ? 'completed' : 'failed';
    const result = completed ? String(ev.result ?? '') : textValue(ev.result ?? row.result ?? '');
    const error = completed ? null : String(ev.error || 'Execution was interrupted.');
    if (run.messageId) {
      statements.push(env.DB.prepare(`UPDATE messages SET body=CASE WHEN ? THEN ? ELSE body END,state=?,error=? WHERE id=? AND ${guard}`).bind(completed ? 1 : 0, result, completed ? 'complete' : 'error', error, run.messageId, ...params));
      const message = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(run.messageId).first<Record<string, unknown>>();
      if (message) event('message.updated', { message: { id: message.id, room: message.room, memberId: message.member_id, name: message.name, body: completed ? result : message.body, createdAt: message.created_at, runId: id, state: completed ? 'complete' : 'error', error } });
    }
    if (ev.type === 'checkpoint') statements.push(env.DB.prepare(`INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'checkpoint',?,? WHERE ${guard}`).bind(id, JSON.stringify({result}), ts, ...params));
    if (ev.type === 'input.requested') statements.push(env.DB.prepare(`INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'input.requested',?,? WHERE ${guard}`).bind(id, JSON.stringify({question:result}), ts, ...params));
    event(ev.type === 'input.requested' || ev.type === 'checkpoint' ? 'run.updated' : completed ? 'run.completed' : 'run.failed', { run: { ...run, status, result, error, endedAt: ts, inputTokens: ev.inputTokens ?? run.inputTokens, outputTokens: ev.outputTokens ?? run.outputTokens }, runId: id, error });
    if (!completed) statements.push(rejectPendingApprovals(env, id));
    statements.push(env.DB.prepare(`UPDATE runs SET status=?,result=?,error=?,input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens),ended_at=?,lease_until=NULL,last_seq=? WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting')`)
      .bind(status, result, error, ev.inputTokens ?? null, ev.outputTokens ?? null, ts, ev.seq, id, ev.attempt, row.last_seq));
  }
  if (ev.type === 'delta' || ev.type === 'tool') statements.push(env.DB.prepare("UPDATE runs SET last_seq=?,lease_until=? WHERE id=? AND attempt=? AND last_seq=? AND status IN ('running','awaiting')").bind(ev.seq, leaseUntil(), id, ev.attempt, row.last_seq));
  // D1 batches are atomic: the sequence advances after all conditionally guarded writes.
  await env.DB.batch(statements);
  return ok({ ok: true });
}
