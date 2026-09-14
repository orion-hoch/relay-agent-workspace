import { env } from '@/lib/server/env';
import { body, now, ok } from '@/lib/buzz/db';
import { getConfig, userById } from '@/lib/server/team';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const config = await getConfig();
  const device = request.headers.get('x-shoal-device');
  if (!device || !config?.terminalEnabled) return ok({ job: null });
  const p = await body<{ runnerId?: string }>(request);
  if (!p?.runnerId) return ok({ job: null });
  await env.DB.prepare('UPDATE execution_devices SET seen_at=? WHERE id=?')
    .bind(now(), device)
    .run();
  await env.DB.prepare(
    "UPDATE terminal_jobs SET status='failed',error='The execution device disconnected. Inspect previous results before rerunning.',ended_at=? WHERE status='running' AND lease_until<?",
  )
    .bind(now(), now())
    .run();
  const row = await env.DB.prepare(
    "UPDATE terminal_jobs SET status='running',runner_id=?,started_at=?,lease_until=? WHERE id=(SELECT j.id FROM terminal_jobs j JOIN users u ON u.id=j.actor_id WHERE j.status='queued' AND j.device_id=? AND u.active=1 ORDER BY j.created_at LIMIT 1) AND status='queued' RETURNING *",
  )
    .bind(
      p.runnerId.slice(0, 120),
      now(),
      new Date(Date.now() + 15000).toISOString(),
      device,
    )
    .first<Record<string, unknown>>();
  if (!row) return ok({ job: null });
  const requester = await userById(String(row.actor_id));
  if (!requester?.active) return ok({ job: null });
  const target = await env.DB.prepare(
    'SELECT work_directory FROM execution_devices WHERE id=? AND enabled=1',
  )
    .bind(device)
    .first<{ work_directory: string }>();
  if (!target) {
    await env.DB.prepare(
      "UPDATE terminal_jobs SET status='cancelled',ended_at=?,error='Execution device revoked.' WHERE id=? AND status='running'",
    )
      .bind(now(), row.id)
      .run();
    return ok({ job: null });
  }
  return ok({
    job: {
      id: row.id,
      command: row.command,
      cwd: row.cwd,
      root: target.work_directory,
      timeout: config.terminalTimeout,
    },
  });
}
