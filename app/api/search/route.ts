import { actor } from '@/lib/server/team';
import { readableRooms, publicRoom } from '@/lib/server/access';
import { resolveContextRoom } from '@/lib/buzz/context-scope';
import { env } from '@/lib/server/env';
import { mapMessage, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 200).toLowerCase();
  if (!q) return ok({ messages: [] });
  const user = actor(request), rooms = await readableRooms(env, user);
  if (!rooms.length) return ok({ messages: [] });
  const pattern = '%' + q.replace(/[!%_]/g, '!$&') + '%';
  const rows = await env.DB.prepare(`SELECT * FROM messages WHERE room IN (${rooms.map(() => '?').join(',')}) AND lower(body) LIKE ? ESCAPE '!' ORDER BY created_at DESC, id DESC LIMIT 50`).bind(...rooms, pattern).all<Record<string, unknown>>();
  const messages = [];
  for (const row of rows.results) {
    const room = String(row.room), root = await resolveContextRoom(env, room);
    const parent = room.startsWith('thread:') ? await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(room.slice(7)).first<Record<string, unknown>>() : null;
    messages.push({ ...mapMessage(row), room: publicRoom(room, user.id), conversation: publicRoom(root!, user.id), parent: parent ? { ...mapMessage(parent), room: publicRoom(String(parent.room), user.id) } : null });
  }
  return ok({ messages });
}
