import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, ensureSchema, fail, now, ok, runnerAuthorized } from '@/lib/buzz/db';
import { TELEMETRY_KEY, validMetrics } from '@/lib/buzz/telemetry';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const e = env as unknown as BuzzEnv;
  if (!runnerAuthorized(request, e)) return fail('Runner token required.', 401);
  const input = await body<{ runnerId?: string; metrics?: unknown }>(request);
  if (typeof input?.runnerId !== 'string' || !input.runnerId.trim() || input.runnerId.length > 200) return fail('Runner identity required.');
  if (!validMetrics(input.metrics)) return fail('Valid measured host statistics required.');
  await ensureSchema(e);
  const receivedAt = now();
  await e.DB.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(TELEMETRY_KEY, JSON.stringify({ runnerId: input.runnerId, metrics: input.metrics, receivedAt })).run();
  return ok({ receivedAt });
}
