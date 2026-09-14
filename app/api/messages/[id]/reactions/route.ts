import emojiGroups from '@/lib/emoji-data.json';
import { actor } from '@/lib/server/team';
import { canReadRoom } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, emit, fail, mapMessage, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
const REACTIONS = new Set(emojiGroups.flatMap(group => group.emojis.map(([emoji]) => emoji)));
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const emoji = String((await body<{ emoji?: string }>(request))?.emoji ?? '');
  if (!REACTIONS.has(emoji)) return fail('Choose one of the available reactions.');
  const user = actor(request);
  // Compare-and-swap protects concurrent writers on both storage backends.
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first<Record<string, unknown>>();
    if (!row || !(await canReadRoom(env, user, String(row.room)))) return fail('Message not found.', 404);
    const reactions = mapMessage(row).reactions ?? {};
    const ids = reactions[emoji] ?? [];
    reactions[emoji] = ids.includes(user.id) ? ids.filter(member => member !== user.id) : [...ids, user.id];
    if (!reactions[emoji].length) delete reactions[emoji];
    const result = await env.DB.prepare('UPDATE messages SET reactions=? WHERE id=? AND reactions=?')
      .bind(JSON.stringify(reactions), id, String(row.reactions)).run();
    if (!result.meta.changes) continue;
    // Clients reload the durable state; racing responses cannot replace a newer
    // reaction set with an older copy of the whole message.
    await emit(env, 'message.reactions', { messageId: id });
    return ok({ ok: true });
  }
  return fail('Reactions changed at the same time. Please try again.', 409);
}
