import { env } from 'cloudflare:workers';
import { type BuzzEnv, body, emit, ensureSchema, fail, ok, sameOrigin } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
const keys = new Set(['canvases', 'preferences', 'workspaceName', 'huddleRooms']);

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return fail('Forbidden', 403);
  const e = env as unknown as BuzzEnv;
  await ensureSchema(e);
  const data = await body<{ key: string; value: unknown }>(request);
  if (!data || !keys.has(data.key)) return fail('Unknown workspace setting.');
  const value = JSON.stringify(data.value);
  if (!value || value.length > 500000) return fail('Workspace value is too large.');
  if (data.key === 'workspaceName' && (typeof data.value !== 'string' || !data.value.trim() || data.value.length > 60)) return fail('Enter a workspace name of 1–60 characters.');
  await e.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(`ui:${data.key}`, value).run();
  const seq = await emit(e, 'workspace.updated', { key: data.key, value: data.value });
  return ok({ key: data.key, value: data.value, seq });
}
