import { actor, isAdmin } from '@/lib/server/team';
import { canUseAgent } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, fail, ok } from '@/lib/buzz/db';
import { agentLevel, getAgent, retrieve } from '@/lib/buzz/context';
import { loadPrivacyLayers } from '@/lib/privacy-layers';
export const dynamic = 'force-dynamic';
// Scoped retrieval for the context inspector and, later, for worker tools.
export async function POST(request: Request) {
  const p = await body<{ query?: string; agentId?: string; k?: number }>(request);
  const query = String(p?.query ?? '').trim();
  if (!query) return fail('Missing query.');
  const agent = p?.agentId ? await getAgent(env, p.agentId) : null;
  if (p?.agentId && (!agent || !canUseAgent(actor(request),agent))) return fail('Agent not found.', 404);
  const passages = await retrieve(env, query, agent ? agentLevel(agent,await loadPrivacyLayers(env)) : 'Restricted', Math.max(1, Math.min(Number(p?.k) || 6, 20)), agent, isAdmin(actor(request)) ? undefined : [actor(request).id]);
  return ok({ passages });
}
