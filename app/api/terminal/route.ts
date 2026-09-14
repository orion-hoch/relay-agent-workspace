import { env } from '@/lib/server/env';
import { actor, audit, isAdmin } from '@/lib/server/team';
import { body, fail, now, textValue, ok } from '@/lib/buzz/db';
import { createTerminal, mapTerminal } from '@/lib/server/terminal';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = actor(request);
  const jobId = new URL(request.url).searchParams.get('id');
  const rows = await env.DB.prepare(
    `SELECT * FROM terminal_jobs WHERE ${isAdmin(user) ? '1=1' : 'actor_id=?'} ${jobId ? 'AND id=?' : ''} ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(...(isAdmin(user) ? [] : [user.id]), ...(jobId ? [jobId] : []))
    .all<Record<string, unknown>>();
  return ok({ jobs: rows.results.map(mapTerminal) });
}
export async function POST(request: Request) {
  const user = actor(request);
  const p = await body<Record<string, unknown>>(request);
  if (!p) return fail('Choose a terminal action.');
  if (!p.action || p.action === 'run') {
    try {
      return ok({ job: await createTerminal(user, p) }, 202);
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : 'Command could not be queued.',
        400,
      );
    }
  }
  const row = await env.DB.prepare('SELECT * FROM terminal_jobs WHERE id=?')
    .bind(String(p.id))
    .first<Record<string, unknown>>();
  if (!row || (!isAdmin(user) && row.actor_id !== user.id))
    return fail('Command not found.', 404);
  if (p.action === 'cancel') {
    await env.DB.prepare(
      "UPDATE terminal_jobs SET status='cancelled',ended_at=?,error='Cancelled by a workspace member.' WHERE id=? AND status IN ('awaiting','queued','running')",
    )
      .bind(now(), row.id)
      .run();
  } else if (['approve', 'reject'].includes(textValue(p.action))) {
    if (!isAdmin(user))
      return fail('An admin must approve terminal commands.', 403);
    if (
      p.command !== row.command ||
      p.deviceId !== row.device_id ||
      p.cwd !== row.cwd
    )
      return fail(
        'Review the exact command, device, and directory before deciding.',
        409,
      );
    if (row.status !== 'awaiting')
      return fail('This command has already been decided.', 409);
    await env.DB.prepare(
      "UPDATE terminal_jobs SET status=?,approved_by=?,ended_at=? WHERE id=? AND status='awaiting'",
    )
      .bind(
        p.action === 'approve' ? 'queued' : 'rejected',
        user.id,
        p.action === 'approve' ? null : now(),
        row.id,
      )
      .run();
  } else return fail('Unknown action.');
  await audit(user.id, 'terminal.' + textValue(p.action), { id: row.id });
  return ok({ ok: true });
}
