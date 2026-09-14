import { getConfig, actor, isAdmin } from '@/lib/server/team';
import { env } from '@/lib/server/env';
import { body, emit, fail, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
const keys = new Set(['canvases', 'workspaceName']);

export async function PUT(request: Request) {
  const data = await body<{ key: string; value: unknown }>(request);
  if (data && data.key!=='canvases' && !isAdmin(actor(request))) return fail('Workspace configuration requires an admin.',403);
  if (!data || !keys.has(data.key)) return fail('Unknown workspace setting.');
  if (data.key==='canvases') {
    if (!data.value || typeof data.value!=='object' || Array.isArray(data.value)) return fail('Provide channel canvases.');
    const channels=await env.DB.prepare('SELECT name FROM channels').all<{name:string}>();
    if (Object.keys(data.value).some(key=>!channels.results.some(channel=>channel.name===key))) return fail('Canvases are supported in shared channels only.');
  }
  const value = JSON.stringify(data.value);
  if (!value || value.length > 500000) return fail('Workspace value is too large.');
  if (data.key === 'workspaceName' && (typeof data.value !== 'string' || !data.value.trim() || data.value.length > 60)) return fail('Enter a workspace name of 1–60 characters.');
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(`ui:${data.key}`, value).run();
  if (data.key==='workspaceName') { const config=await getConfig(); if (config) await env.DB.prepare("UPDATE settings SET value=? WHERE key='team_config'").bind(JSON.stringify({...config,name:String(data.value)})).run(); }
  const seq = await emit(env, 'workspace.updated', { key: data.key, value: data.value });
  return ok({ key: data.key, value: data.value, seq });
}
