import { env } from '@/lib/server/env';
import { body, fail, now, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const p = await body<{
    id?: string;
    runnerId?: string;
    type?: string;
    seq?: number;
    text?: string;
    exitCode?: number;
    error?: string;
    nextCwd?: string;
  }>(request);
  const row = await env.DB.prepare('SELECT * FROM terminal_jobs WHERE id=?')
    .bind(p?.id || '')
    .first<Record<string, unknown>>();
  if (
    !p ||
    !row ||
    row.device_id !== request.headers.get('x-shoal-device') ||
    row.runner_id !== p.runnerId ||
    row.status !== 'running' ||
    String(row.lease_until) < now()
  )
    return fail('This execution lease has ended.', 409);
  const lease = new Date(Date.now() + 15000).toISOString();
  if (p.type === 'heartbeat') {
    await env.DB.batch([
      env.DB.prepare("UPDATE terminal_jobs SET lease_until=? WHERE id=? AND status='running' AND runner_id=?").bind(lease, row.id, p.runnerId),
      env.DB.prepare('UPDATE execution_devices SET seen_at=? WHERE id=? AND enabled=1').bind(now(), row.device_id),
    ]);
    return ok({ ok: true });
  }
  if (!Number.isInteger(p.seq) || p.seq! < 1)
    return fail('An ordered event sequence is required.');
  if (p.seq! <= Number(row.last_seq)) return ok({ ok: true });
  if (p.seq !== Number(row.last_seq) + 1)
    return fail('Out-of-order terminal event.', 409);
  if (!['output', 'done', 'failed'].includes(p.type || ''))
    return fail('Unknown terminal event.');
  const text = typeof p.text === 'string' ? p.text.slice(0, 16384) : '';
  const status =
    p.type === 'done'
      ? p.exitCode === 0
        ? 'completed'
        : 'failed'
      : p.type === 'failed'
        ? 'failed'
        : 'running';
  const nextCwd = typeof p.nextCwd === 'string' && p.nextCwd.length <= 1000 && !p.nextCwd.startsWith('/') && !p.nextCwd.split(/[\\/]/).includes('..') && !p.nextCwd.includes('\0') ? p.nextCwd : null;
  const result = await env.DB.prepare(
    "UPDATE terminal_jobs SET output=substr(output || ?,1,262144),status=?,exit_code=?,error=?,ended_at=?,last_seq=?,lease_until=?,next_cwd=COALESCE(?,next_cwd) WHERE id=? AND runner_id=? AND status='running' AND last_seq=? AND lease_until>? RETURNING id",
  )
    .bind(
      text,
      status,
      Number.isInteger(p.exitCode) ? p.exitCode! : null,
      typeof p.error === 'string' ? p.error.slice(0, 1000) : null,
      status === 'running' ? null : now(),
      p.seq,
      lease,
      nextCwd,
      row.id,
      p.runnerId,
      p.seq - 1,
      now(),
    )
    .first();
  return result
    ? ok({ ok: true })
    : fail('This execution lease has ended.', 409);
}
