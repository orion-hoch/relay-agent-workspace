'use client';
// Client store for the shared workspace: one snapshot from /api/state, then /api/events polling.
// ponytail: 1.5 s polling; swap for a WebSocket/Durable Object when it measurably matters.
import { useSyncExternalStore } from 'react';
import type { ApprovalRecord, DocumentRecord, EventRecord, MemberRecord, MessageRecord, NodeRecord, RunMode, RunRecord, TaskRecord, WorkspaceState } from './types';

export type BuzzStore = WorkspaceState & { loaded: boolean; online: boolean };
const empty: BuzzStore = { uiState: {}, members: [], channels: [], messages: [], projects: [], tasks: [], runs: [], documents: [], approvals: [], nodes: [], collections: [], rules: '', cursor: 0, loaded: false, online: true };
let state: BuzzStore = empty;
const listeners = new Set<() => void>();
function set(next: BuzzStore) { state = next; listeners.forEach((l) => l()); }
function upsert<T extends { id: string }>(list: T[], item: T): T[] { const i = list.findIndex((x) => x.id === item.id); return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x)); }

export function apply(events: EventRecord[]) {
  let s = state;
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case 'channel.created': s = { ...s, channels: s.channels.includes(p.name as string) ? s.channels : [...s.channels, p.name as string] }; break;
      case 'workspace.updated': { const key = p.key as string; if (workspaceWrites.has(key) || ev.seq <= (workspaceRevisions.get(key) ?? -1)) break; s = { ...s, uiState: { ...s.uiState, [key]: p.value } }; break; }
      case 'message.created': case 'message.updated': {
        const m = p.message as MessageRecord;
        s = { ...s, messages: upsert(s.messages, m), channels: m.room.startsWith('dm:') || m.room.startsWith('thread:') || s.channels.includes(m.room) ? s.channels : [...s.channels, m.room] };
        break;
      }
      case 'run.delta': {
        const { messageId, text } = p as { messageId?: string; text: string };
        if (messageId) s = { ...s, messages: s.messages.map((m) => (m.id === messageId ? { ...m, body: m.body + text } : m)) };
        break;
      }
      case 'run.queued': case 'run.started': case 'run.updated': case 'run.completed': s = { ...s, runs: upsert(s.runs, p.run as RunRecord) }; break;
      case 'run.failed': {
        const run = p.run as RunRecord | undefined;
        const runId = (p.runId as string) ?? run?.id;
        const error = (p.error as string | undefined) ?? run?.error ?? 'The agent could not complete this request.';
        s = { ...s,
          runs: run ? upsert(s.runs, run) : s.runs.map((r) => r.id === runId ? { ...r, status: 'failed', error } : r),
          messages: s.messages.map((m) => m.runId === runId ? { ...m, state: 'error', error } : m),
        };
        break;
      }
      case 'task.refresh': void load(); break;
      case 'task.created': case 'task.updated': s = { ...s, tasks: upsert(s.tasks, p.task as TaskRecord) }; break;
      case 'document.created': case 'document.updated': { const d = p.document as DocumentRecord; s = { ...s, documents: upsert(s.documents, d), collections: s.collections.includes(d.collection) ? s.collections : [...s.collections, d.collection] }; break; }
      case 'document.deleted': s = { ...s, documents: s.documents.filter((d) => d.id !== (p.id as string)) }; break;
      case 'approval.created': case 'approval.updated': s = { ...s, approvals: upsert(s.approvals, p.approval as ApprovalRecord) }; break;
      case 'member.deleted': s = { ...s, members: s.members.filter(member => member.id !== p.id) }; break;
      case 'member.updated': s = { ...s, members: upsert(s.members, p.member as MemberRecord) }; break;
      case 'node.updated': s = { ...s, nodes: upsert(s.nodes, p.node as NodeRecord) }; break;
    }
    s = { ...s, cursor: Math.max(s.cursor, ev.seq) };
  }
  if (s !== state) set(s);
}

let started = false;
async function load() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as WorkspaceState;
    set({ ...data, loaded: true, online: true });
  } catch { set({ ...state, online: false }); }
}
async function poll() {
  for (;;) {
    await new Promise((r) => setTimeout(r, document.visibilityState === 'visible' ? 1500 : 6000));
    try {
      if (!state.loaded) { await load(); continue; }
      const res = await fetch(`/api/events?after=${state.cursor}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { events: EventRecord[] };
      if (!state.online) set({ ...state, online: true });
      if (data.events.length) apply(data.events.filter((event) => event.seq > state.cursor));
    } catch { if (state.online) set({ ...state, online: false }); }
  }
}
export function start() { if (started || typeof window === 'undefined') return; started = true; void load().then(poll); }
export function useBuzz(): BuzzStore { start(); return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => empty); }
export function refresh() { return load(); }

// Mutations: every write goes to the API; the event stream brings the durable record back.
async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
  return data as T;
}
const workspaceWrites = new Map<string, Promise<void>>();
const workspaceRevisions = new Map<string, number>();
function saveWorkspaceSetting(key: string, value: unknown): Promise<void> {
  if (!state.loaded) return Promise.reject(new Error('Workspace is still loading. Please try again.'));
  const previous = state.uiState[key];
  set({ ...state, uiState: { ...state.uiState, [key]: value } });
  const write = (workspaceWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const result = await call<{ seq: number }>('/api/workspace', { method: 'PUT', body: JSON.stringify({ key, value }) });
    workspaceRevisions.set(key, result.seq);
  }).catch(error => {
    if (state.uiState[key] === value) set({ ...state, uiState: { ...state.uiState, [key]: previous } });
    throw error;
  });
  workspaceWrites.set(key, write);
  void write.finally(() => { if (workspaceWrites.get(key) === write) workspaceWrites.delete(key); }).catch(() => {});
  return write;
}
export const buzz = {
  createChannel: (name: string) => call<{ name: string }>('/api/channels', { method: 'POST', body: JSON.stringify({ name }) }).then(r => { apply([{ seq: state.cursor, ts: '', type: 'channel.created', payload: r }]); return r; }),
  saveWorkspaceSetting,
  sendMessage: (room: string, text: string, clientId: string, mode: RunMode = 'quick', memberId = 'you') => call<{ message: MessageRecord; runs: string[] }>('/api/messages', { method: 'POST', body: JSON.stringify({ room, text, clientId, memberId, mode }) }).then((r) => { apply([{ seq: state.cursor, ts: r.message.createdAt, type: 'message.created', payload: { message: r.message } }]); return r; }),
  createTask: (task: Partial<TaskRecord>) => call<{ task: TaskRecord }>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'task.created', payload: { task: r.task } }]); return r.task; }),
  updateTask: (id: string, patch: Partial<TaskRecord> & { comment?: string }) => call<{ task: TaskRecord }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'task.updated', payload: { task: r.task } }]); return r.task; }),
  startRun: (taskId: string, agentId: string, mode: RunMode = 'deep') => call<{ run: RunRecord; task: TaskRecord }>('/api/runs', { method: 'POST', body: JSON.stringify({ taskId, agentId, mode }) }),
  retryRun: (retryRunId: string, mode?: RunMode) => call<{ run: RunRecord }>('/api/runs', { method: 'POST', body: JSON.stringify({ retryRunId, mode }) }),
  inspectRun: (id: string) => call<{ run: RunRecord; events: { id: number; type: string; payload: Record<string, unknown>; ts: string }[] }>(`/api/runs?id=${encodeURIComponent(id)}`, { method: 'GET' }),
  decide: (id: string, decision: 'Approved' | 'Rejected', action?: string) => call<{ approval: ApprovalRecord }>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision, action }) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'approval.updated', payload: { approval: r.approval } }]); return r.approval; }),
  saveAgent: (agent: Record<string, unknown>) => call<{ member: MemberRecord }>('/api/agents', { method: 'POST', body: JSON.stringify(agent) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'member.updated', payload: { member: r.member } }]); return r.member; }),
  deleteAgent: (id: string) => call<{ ok: true }>(`/api/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => apply([{ seq: state.cursor, ts: '', type: 'member.deleted', payload: { id } }])),
  retrieve: (query: string, agentId?: string, k = 6) => call<{ passages: import('./types').Passage[] }>('/api/context', { method: 'POST', body: JSON.stringify({ query, agentId, k }) }),
  importDocument: async (file: File, meta: { collection: string; level: string; owner?: string; audiences?: string[]; agents?: string[] }) => {
    const form = new FormData();
    form.set('file', file); form.set('collection', meta.collection); form.set('level', meta.level); form.set('owner', meta.owner ?? 'you');
    form.set('audiences', JSON.stringify(meta.audiences ?? [])); form.set('agents', JSON.stringify(meta.agents ?? []));
    const res = await fetch('/api/documents', { method: 'POST', body: form });
    const data = (await res.json().catch(() => null)) as { document: DocumentRecord; error?: string } | null;
    if (!res.ok) throw new Error(data?.error || `Import failed (${res.status}).`);
    apply([{ seq: state.cursor, ts: '', type: 'document.updated', payload: { document: data!.document } }]);
    return data!.document;
  },
  deleteDocument: (id: string) => call<{ ok: true }>(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => apply([{ seq: state.cursor, ts: '', type: 'document.deleted', payload: { id } }])),
  documentUrl: (id: string) => `/api/documents?id=${encodeURIComponent(id)}`,
  runtime: () => call<{ homes: { id: string; name: string; connected: boolean; model: string }[]; nodes: NodeRecord[] }>('/api/runtime', { method: 'GET' }).then((r) => { set({ ...state, nodes: r.nodes }); return r; }),
};
