import type { RunRecord } from './types';

/** Adapt an observed native worker to the existing chat activity's run contract. */
export function nativeChildRun(parent: RunRecord, value: unknown): RunRecord | null {
  if (!value || typeof value !== 'object') return null;
  const child = value as Record<string, unknown>;
  if (typeof child.nativeRunId !== 'string' || typeof child.agentId !== 'string' || !['accepted', 'running', 'completed', 'failed'].includes(String(child.status))) return null;
  const interrupted = ['failed','cancelled'].includes(parent.status) && ['accepted', 'running'].includes(String(child.status));
  const text = (key: string) => typeof child[key] === 'string' ? child[key] as string : null;
  return {
    id: `${child.backend==='vllm'?'direct':'native'}:${child.nativeRunId}`, kind: 'subtask', parentRunId: parent.id,
    agentId: child.agentId, room: parent.room,
    status: interrupted ? (parent.status==='cancelled'?'cancelled':'failed') : child.status === 'accepted' ? 'queued' : child.status === 'running' ? 'running' : child.status === 'completed' ? 'completed' : 'failed',
    backend: child.backend==='vllm'?'vllm':'openclaw', mode: parent.mode, model: text('model'),
    result: text('result'), error: interrupted ? 'The parent run ended before this worker’s completion was recorded.' : text('error'), createdAt: text('acceptedAt') || parent.createdAt,
    startedAt: text('startedAt'), endedAt: interrupted ? parent.endedAt : text('completedAt'),
    inputTokens: typeof child.inputTokens === 'number' ? child.inputTokens : null,
    outputTokens: typeof child.outputTokens === 'number' ? child.outputTokens : null,
  };
}
