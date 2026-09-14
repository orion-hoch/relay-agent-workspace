import {checkSharedSources,collaborators} from '@/lib/server/collaboration';
import {agentWorkspace} from '@/lib/server/agent-workspace';
import { createHash } from 'node:crypto';
import { agentHomeId, modelFitsHome } from '@/lib/model-home';
import { assertEndpoint } from '@/lib/server/network';
import { userById, isAdmin } from '@/lib/server/team';
import { canUseAgent, canReadRoom } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, emit, fail, mapRun, now, ok } from '@/lib/buzz/db';
import { configuredModels, selectedModel, retrievalEnvironment, assertModelEndpoint } from '@/lib/buzz/models';
import { buildPacket, getAgent } from '@/lib/buzz/context';
import { failRun, leaseUntil } from '@/lib/buzz/runs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  if (request.headers.get('x-shoal-device') !== 'local') return fail('Runner token required.', 401);
  const p = await body<{ runnerId?: string }>(request);
  if (!p?.runnerId) return fail('Runner identity required.');
  const expired = await env.DB.prepare("UPDATE runs SET status='failed', error='The runner disconnected. Review any completed actions before retrying.', ended_at=?, lease_until=NULL WHERE status IN ('preparing','running','awaiting') AND lease_until < ? RETURNING id").bind(now(), now()).all<{ id: string }>();
  for (const r of expired.results) await failRun(env, r.id, 'The runner disconnected. Review any completed actions before retrying.');
  const row = await env.DB.prepare("UPDATE runs SET status='preparing', started_at=?, runner_id=?, attempt=attempt+1, last_seq=0, lease_until=? WHERE id=(SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *")
    .bind(now(), p.runnerId.slice(0, 120), leaseUntil()).first<Record<string, unknown>>();
  if (!row) return ok({ run: null });
  const run = mapRun(row);
  try {
    const agent = await getAgent(env, run.agentId);
    if (!agent || agent.data.paused) throw new Error('The requested agent is missing or paused.');
    const requester=await userById(typeof row.requested_by==='string'?row.requested_by:'you');
    if (!requester?.active || !canUseAgent(requester,agent) || !await canReadRoom(env,requester,run.room || null)) throw new Error('The requester no longer has access to this agent or conversation.');
    const trigger = run.triggerMessageId ? await env.DB.prepare('SELECT body FROM messages WHERE id = ?').bind(run.triggerMessageId).first<{ body: string }>() : null;
    if (!trigger) throw new Error('The original message is missing. Send a new request.');
    const objective = trigger.body;
    let contract: string | null = null;
    if (run.parentRunId) {
      const previous = await env.DB.prepare('SELECT result, error FROM runs WHERE id=?').bind(run.parentRunId).first<{ result?: string; error?: string }>();
      contract = `Continuation of ${run.parentRunId}. Preserve previous work; inspect action receipts before repeating any action.\nPrevious outcome:\n${(previous?.result || previous?.error || 'Interrupted; inspect the existing session.').slice(-8000)}`;
    }
    if(typeof row.task_id==='string'){
      const repository=await env.DB.prepare("SELECT id FROM connections WHERE id=? AND kind='git'").bind('git:'+row.task_id).first();
      contract=[repository?'Repository files are checked out in /workspace. Inspect and edit them as requested. The user controls Git commits and pushes in the task UI.':'', 'Work toward the goal using available tools. Inspect action results. Report the outcome, files created, and remaining work or blockers. Claim completion only with evidence.',contract].filter(Boolean).join('\n\n');
    }
    const connectionId = typeof row.connection_id === 'string' ? row.connection_id : run.model;
    const inference = (await configuredModels(env, requester.id)).find(item => item.id === connectionId) || (!connectionId ? await selectedModel(env, agent.id) : null);
    if (!inference) throw new Error('This run’s model connection no longer exists. Choose another model and retry.');
    if (!modelFitsHome(inference, agentHomeId(agent.data))) throw new Error('The agent’s home changed. Choose a model in its current home and retry.');
    await assertModelEndpoint(env,inference);
    if (inference.error) throw new Error(inference.error);
    if (inference.execution==='openclaw') {if(!isAdmin(requester))throw new Error('Native tool runtimes require an admin.');if(env.BUZZ_OPENCLAW_URL)await assertEndpoint(env,env.BUZZ_OPENCLAW_URL);}
    if (run.model && run.model !== inference.model) throw new Error('The served model changed after this run was queued. Retry to use the new configuration.');
    if (inference.execution === 'openclaw' && !env.BUZZ_OPENCLAW_URL) throw new Error('Configure the OpenClaw gateway before using this agent connection.');
    // OpenClaw adds ~8K tokens of native instructions; leave room for tool results in the 32K model window.
    const budget = Math.min(run.mode === 'deep' ? 65536 : 16384, inference.contextWindow - (inference.execution === 'openclaw' ? 8192 : 0));
    if (budget < 2048) throw new Error('The configured context window is too small for this runtime.');
    const outputReserve = Math.min(run.mode === 'deep' ? 4096 : 2048, Math.floor(budget / 3));
    const sandboxScope = inference.execution==='vllm' && requester.role!=='viewer' ? createHash('sha256').update(JSON.stringify([requester.id,agent.id,run.room || run.id])).digest('hex') : undefined;
    if(sandboxScope)await checkSharedSources(env,requester,agent.id,run.room || null,agent);
    const workspace=sandboxScope ? await agentWorkspace(env,agent,typeof row.task_id==='string'?row.task_id:undefined) : undefined;
    const peers=sandboxScope ? await collaborators(env,requester,agent.id,run.room || null) : [];
    const packet = await buildPacket({ ...await retrievalEnvironment(env), BUZZ_MODEL: inference.model, BUZZ_VLLM_URL: inference.url, BUZZ_VLLM_TOKEN: inference.token }, { agent, objective, collaborators:peers.map(agent=>agent.name), inferenceModel:inference.model, toolsEnabled:!!sandboxScope, workspace, repositoryEnabled:!!sandboxScope && typeof row.task_id==='string', room: run.room, taskContract: contract, budgetTokens: budget, outputReserve, sessionKey: `shoal:${run.triggerMessageId}:${agent.id}`, backend: inference.execution, model: inference.execution === 'openclaw' ? `openclaw/${env.BUZZ_OPENCLAW_AGENT || 'main'}` : inference.model, mode: run.mode, runId: run.id });
    packet.inferenceModel = inference.model;
    await env.DB.prepare("UPDATE runs SET status='running', backend=?, model=?, packet=?, estimated_input_tokens=?, lease_until=? WHERE id=? AND attempt=? AND status='preparing'")
      .bind(inference.execution, inference.model, JSON.stringify(packet), packet.estimatedTokens, leaseUntil(), run.id, run.attempt).run();
    await env.DB.prepare('INSERT INTO run_events(run_id,type,payload,ts) VALUES (?,?,?,?)').bind(run.id, 'context.ready', JSON.stringify({ mode: run.mode, estimatedTokens: packet.estimatedTokens, budgetTokens: budget, evidence: packet.evidence.length, droppedEvidence: packet.droppedEvidence, history: packet.historyMessages, rulesVersion: packet.rulesVersion }), now()).run();
    const updated = mapRun((await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(run.id).first<Record<string, unknown>>())!);
    if (updated.status !== 'running') return ok({ run: null });
    await emit(env, 'run.started', { run: updated });
    return ok({ run: updated, packet, execution: { baseUrl: inference.url, token: inference.token || '', runtimeModel: inference.runtimeModel, provider: inference.provider, agentId:agent.id, canCollaborate:peers.length>0, canCheckoutRepository:!!sandboxScope && typeof row.task_id==='string', sandboxScope, workspace } });
  } catch (error) {
    await failRun(env, run.id, error instanceof Error ? error.message : 'Context assembly failed.');
    return ok({ run: null });
  }
}
