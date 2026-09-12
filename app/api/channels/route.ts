import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, emit, ensureSchema, fail, now, ok, sameOrigin } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail('Forbidden', 403);
  const e = env as unknown as BuzzEnv;
  await ensureSchema(e);
  const data = await body<{ name: string }>(request);
  const name = typeof data?.name === 'string' ? data.name.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(name)) return fail('Use 1–60 letters, numbers, hyphens or underscores.');
  await e.DB.prepare('INSERT OR IGNORE INTO channels(name, created_at) VALUES (?,?)').bind(name, now()).run();
  await emit(e, 'channel.created', { name });
  return ok({ name });
}
