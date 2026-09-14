import { actor, isAdmin } from '@/lib/server/team';
import { canReadRun, publicRun } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { emit, fail, mapRun, mapMessage, now, ok } from '@/lib/buzz/db';
import { abortNative } from '@/lib/server/openclaw';
import type { Packet } from '@/lib/buzz/types';
import { rejectPendingApprovals } from '@/lib/buzz/runs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const row = await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<Record<string, unknown>>();
  const user=actor(request);
  if (!row || !await canReadRun(env,user,id) || (!isAdmin(user) && row.requested_by!==user.id)) return fail('Run not found or cancellation not permitted.',404);
  if (!['queued','preparing','running','awaiting'].includes(String(row.status))) return ok({ run: publicRun(mapRun(row),user.id) });
  if (row.backend === 'openclaw' && ['running','awaiting'].includes(String(row.status))) {
    const packet = JSON.parse(String(row.packet)) as Packet;
    if (!env.BUZZ_OPENCLAW_URL || !env.BUZZ_OPENCLAW_TOKEN) return fail('The native gateway is not configured. Stop this task in OpenClaw.', 409);
    try { await abortNative(env.BUZZ_OPENCLAW_URL, env.BUZZ_OPENCLAW_TOKEN, `agent:${packet.model.replace('openclaw/','')}:${packet.sessionKey.toLowerCase()}`); }
    catch (error) { return fail(error instanceof Error ? error.message : 'Native cancellation failed.', 502); }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE runs SET status='cancelled',error='Stopped by a workspace member.',ended_at=?,lease_until=NULL WHERE id=? AND status IN ('queued','preparing','running','awaiting')").bind(now(), id),
    env.DB.prepare("UPDATE messages SET state='error',error='Stopped by a workspace member.' WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='cancelled')").bind(id, id),
    rejectPendingApprovals(env, id, user.id),
  ]);
  const run = mapRun((await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<Record<string, unknown>>())!);
  await emit(env, 'run.updated', { run });
  const message = await env.DB.prepare('SELECT * FROM messages WHERE run_id=?').bind(id).first<Record<string, unknown>>();
  if (message) await emit(env, 'message.updated', { message: mapMessage(message) });
  return ok({ run:publicRun(run,user.id) });
}
