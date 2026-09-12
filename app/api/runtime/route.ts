import { env } from 'cloudflare:workers';
import { type BuzzEnv, ensureSchema, mapNode, now, ok } from '@/lib/buzz/db';
import { readHostMetrics } from '@/lib/buzz/telemetry';
export const dynamic = 'force-dynamic';

async function probe(url: string | undefined, path: string, token?: string): Promise<{ up: boolean; models: string[] }> {
  if (!url) return { up: false, models: [] };
  try {
    const res = await fetch(new URL(path, url.replace(/\/$/, '') + '/'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
    if (!res.ok) { await res.body?.cancel(); return { up: false, models: [] }; }
    const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
    return { up: Array.isArray(data?.data), models: (data?.data ?? []).map((m) => m.id) };
  } catch { return { up: false, models: [] }; }
}

// Observed health of the local services. Nothing here is inferred from configuration alone.
export async function GET() {
  const e = env as unknown as BuzzEnv;
  await ensureSchema(e);
  const [inference, embedding, rerank, gateway, metrics] = await Promise.all([
    probe(e.BUZZ_VLLM_URL, 'models', e.BUZZ_VLLM_TOKEN),
    probe(e.BUZZ_EMBED_URL, 'models', e.BUZZ_EMBED_TOKEN),
    probe(e.BUZZ_RERANK_URL, 'v1/models', e.BUZZ_RERANK_TOKEN),
    probe(e.BUZZ_OPENCLAW_URL, 'v1/models', e.BUZZ_OPENCLAW_TOKEN),
    readHostMetrics(e),
  ]);
  const model = e.BUZZ_MODEL || 'gemma';
  const nodeName = e.BUZZ_NODE_NAME || 'Local GB10';
  const inferenceReady = inference.up && inference.models.includes(model);
  const connected = inferenceReady && gateway.up;
  const nodes = [
    { id: 'spark-inference', name: `${nodeName} · inference`, kind: 'inference', status: inferenceReady ? 'inference-healthy' : inference.up ? 'model-loading' : 'unreachable', data: { models: inference.models, url: e.BUZZ_VLLM_URL ?? null } },
    { id: 'spark-embedding', name: `${nodeName} · embeddings`, kind: 'embedding', status: embedding.up ? 'inference-healthy' : 'unreachable', data: { models: embedding.models } },
    { id: 'spark-rerank', name: `${nodeName} · reranker`, kind: 'rerank', status: rerank.up ? 'inference-healthy' : 'unreachable', data: { models: rerank.models } },
    { id: 'openclaw', name: 'OpenClaw · NemoClaw / OpenShell', kind: 'gateway', status: gateway.up ? 'gateway-reachable' : 'unreachable', data: { agents: gateway.models } },
  ];
  const ts = now();
  await e.DB.batch(nodes.map((n) => e.DB.prepare('INSERT INTO nodes(id, name, kind, status, data, seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, data = excluded.data, seen_at = excluded.seen_at').bind(n.id, n.name, n.kind, n.status, JSON.stringify(n.data), ts)));
  const rows = await e.DB.prepare('SELECT * FROM nodes ORDER BY name').all<Record<string, unknown>>();
  return ok({ metrics, homes: [{ id: 'lab', name: nodeName, connected, model, metrics }], nodes: rows.results.map(mapNode) });
}
