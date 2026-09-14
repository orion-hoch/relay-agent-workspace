import { hostname } from 'node:os';
import { modelHomeId, agentHomeId } from '@/lib/model-home';
import { env } from '@/lib/server/env';
import { actor, isAdmin } from '@/lib/server/team';
import { ok } from '@/lib/buzz/db';
import { readHostMetrics } from '@/lib/buzz/telemetry';
import { selectedModel, retrievalEnvironment, modelAvailability, probeModels as probe } from '@/lib/buzz/models';
export const dynamic = 'force-dynamic';

// Observed health of the local services. Nothing here is inferred from configuration alone.
export async function GET(request: Request) {
  const e = await retrievalEnvironment(env);
  const selected = await selectedModel(e, undefined, actor(request).id).catch(() => null);
  const [models, embedding, rerank, gateway, metrics] = await Promise.all([
    modelAvailability(e, actor(request).id),
    probe(e.BUZZ_EMBED_URL, 'models', e.BUZZ_EMBED_TOKEN),
    probe(e.BUZZ_RERANK_URL, 'v1/models', e.BUZZ_RERANK_TOKEN),
    probe(e.BUZZ_OPENCLAW_URL, 'v1/models', e.BUZZ_OPENCLAW_TOKEN),
    readHostMetrics(e),
  ]);
  const model = selected?.model || '';
  const inference = { up: models.some(item => item.status === 'ready'), models: models.filter(item => item.status === 'ready').map(item => item.model) };
  const nodeName = e.BUZZ_NODE_NAME || hostname();
  const inferenceReady = inference.up && inference.models.includes(model);
  const nodes = [
    { id: 'spark-inference', name: `${nodeName} · inference`, kind: 'inference', status: inferenceReady ? 'inference-healthy' : inference.up ? 'model-loading' : 'unreachable', data: { models: inference.models, url: selected?.url ?? null } },
    { id: 'spark-embedding', name: `${nodeName} · embeddings`, kind: 'embedding', status: embedding.up ? 'inference-healthy' : 'unreachable', data: { models: embedding.models } },
    { id: 'spark-rerank', name: `${nodeName} · reranker`, kind: 'rerank', status: rerank.up ? 'inference-healthy' : 'unreachable', data: { models: rerank.models } },
    { id: 'openclaw', name: 'OpenClaw · NemoClaw / OpenShell', kind: 'gateway', status: gateway.up ? 'gateway-reachable' : 'unreachable', data: { agents: gateway.models } },
  ];
  const admin = isAdmin(actor(request));
  const agents = await e.DB.prepare("SELECT data FROM members WHERE kind='agent'").all<{data:string}>();
  const agentHomes = agents.results.map(row => agentHomeId(JSON.parse(row.data))).filter(id => id !== 'openai-preview');
  const localIds = [...new Set([...agentHomes, ...models.filter(item => !item.provider).map(modelHomeId)])];
  const homes = localIds.map(id => {
    const served = models.filter(item => modelHomeId(item) === id);
    return {id, kind: 'local', name: served.find(item => item.nodeName)?.nodeName || (id === 'lab' ? 'This computer' : id.slice(6)), connected: served.some(item => item.status === 'ready'), modelCount:served.length, model: served[0]?.model || '', ...(id === 'lab' ? {metrics} : {})};
  });
  homes.push({id: 'openai-preview', kind: 'cloud', name: 'Cloud', modelCount:models.filter(item => !!item.provider).length, connected: models.some(item => item.provider && item.status === 'ready'), model: ''});
  return ok({ selectedModel: selected?.id ?? null, models, metrics, homes, nodes: nodes.map(node => admin ? node : { ...node, data: { ...node.data, url: undefined } }) });
}
