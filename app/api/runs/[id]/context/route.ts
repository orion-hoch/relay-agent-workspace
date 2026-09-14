import { env } from '@/lib/server/env';
import { body, fail, now, ok } from '@/lib/buzz/db';
import { getAgent, readContextDocument, retrieve } from '@/lib/buzz/context';
import { canReadHistoryMessage, contextAccess } from '@/lib/buzz/context-scope';
import { retrievalEnvironment } from '@/lib/buzz/models';
import { userById } from '@/lib/server/team';
import { canReadRoom, canUseAgent } from '@/lib/server/access';
import { checkSharedSources } from '@/lib/server/collaboration';
export const dynamic = 'force-dynamic';

type Input = {runnerId?:string; attempt?:number; collaborationId?:string; action?:'search'|'read'; query?:string; source?:'documents'|'conversation'|'all'; k?:number; documentId?:string; start?:number; count?:number};
export async function POST(request: Request, ctx: {params: Promise<{id:string}>}) {
  if (request.headers.get('x-shoal-device') !== 'local') return fail('Runner token required.', 401);
  const { id } = await ctx.params, input = await body<Input>(request);
  const run = await env.DB.prepare('SELECT agent_id,room,status,requested_by,runner_id,attempt,lease_until FROM runs WHERE id=?').bind(id)
    .first<{agent_id:string; room:string|null; status:string; requested_by:string; runner_id:string; attempt:number; lease_until:string|null}>();
  if (!run || !input || run.runner_id !== input.runnerId || run.attempt !== input.attempt || run.status !== 'running' || !run.lease_until || run.lease_until <= now()) return fail('This run is no longer active on this runner.', 409);
  if (!['search', 'read'].includes(input.action || '')) return fail('Choose a search or document read.');
  const user = await userById(run.requested_by), parent = await getAgent(env, run.agent_id);
  if (!user?.active || !parent || !canUseAgent(user, parent) || !await canReadRoom(env, user, run.room)) return fail('This task is no longer available to its requester.', 403);
  try {
    await checkSharedSources(env, user, parent.id, run.room, parent);
    let agent = parent;
    if (input.collaborationId) {
      const grant = await env.DB.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='collaboration.granted' AND json_extract(payload,'$.nativeRunId')=?").bind(id, input.collaborationId).first<{payload:string}>();
      if (!grant) return fail('This collaborator has no context grant.', 403);
      const target = await getAgent(env, String(JSON.parse(grant.payload).agentId));
      if (!target || !canUseAgent(user, target)) return fail('This collaborator is no longer available.', 403);
      await checkSharedSources(env, user, parent.id, run.room, target);
      agent = target;
    }
    const scope = await contextAccess(env, parent, run.room);
    await contextAccess(env, agent, run.room);
    const sharedWith = agent.id === parent.id ? [] : [parent];
    const retrieval = await retrievalEnvironment(env);
    let result: {passages: Awaited<ReturnType<typeof retrieve>>; messages?:{id:string;room:string;name:string;body:string;createdAt:string}[]; nextStart?:number|null};
    if (input.action === 'read') {
      if (typeof input.documentId !== 'string' || !input.documentId || !Number.isInteger(input.start ?? 0) || Number(input.start ?? 0) < 0 || !Number.isInteger(input.count ?? 3) || Number(input.count ?? 3) < 1 || Number(input.count ?? 3) > 8) return fail('Supply a document ID, a nonnegative start index, and a count from 1 to 8.');
      result = await readContextDocument(retrieval, input.documentId, input.start ?? 0, input.count ?? 3, scope.level, agent, scope.readers, sharedWith);
    } else {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000 || !['documents', 'conversation', 'all'].includes(input.source ?? 'all') || !Number.isInteger(input.k ?? 6) || Number(input.k ?? 6) < 1 || Number(input.k ?? 6) > 8) return fail('Supply a query under 2,000 characters, a valid source, and a result count from 1 to 8.');
      const query = input.query.trim(), k = input.k ?? 6;
      result = {passages: input.source === 'conversation' ? [] : await retrieve(retrieval, query, scope.level, k, agent, scope.readers, sharedWith), messages: []};
      if (input.source !== 'documents' && run.room) {
        // Thread searches can recover context from their parent conversation; DMs stay participant-only.
        const rooms = [...new Set([run.room, scope.room].filter((room): room is string => !!room))];
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
        const rows = await env.DB.prepare(`SELECT id,room,member_id,name,body,created_at FROM messages WHERE room IN (${rooms.map(() => '?').join(',')}) AND (state IS NULL OR state='complete') AND (${terms.map(() => "lower(body) LIKE ? ESCAPE '!'").join(' OR ')}) ORDER BY created_at DESC LIMIT 40`)
          .bind(...rooms, ...terms.map(term => '%' + term.replace(/[!%_]/g, '!$&') + '%')).all<{id:string;room:string;member_id:string;name:string;body:string;created_at:string}>();
        result.messages = rows.results.filter(row => [agent, parent].every(reader => canReadHistoryMessage(reader, scope.room, row.member_id))).slice(0, k)
          .map(row => ({id:row.id, room:row.room, name:row.name, body:row.body.slice(0, 2000), createdAt:row.created_at}));
      }
    }
    // Retain source lineage because a later collaborator can read files created from these results.
    const saved = await env.DB.prepare("INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'context.retrieved',?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status='running' AND runner_id=? AND attempt=? AND lease_until>?)")
      .bind(id, JSON.stringify({agentId:agent.id, collaborationId:input.collaborationId, documentIds:[...new Set(result.passages.map(passage => passage.documentId))]}), now(), id, input.runnerId, input.attempt, now()).run();
    if (!saved.meta.changes) return fail('This run ended before the context read completed.', 409);
    return ok(result);
  } catch (error) { return fail(error instanceof Error ? error.message : 'Could not retrieve permitted context.', 403); }
}
