'use client';
// One authorized snapshot, then a resumable stream of visible workspace events.
import { useSyncExternalStore } from 'react';
import type { ApprovalRecord, SearchMessage, DocumentRecord, EventRecord, MemberRecord, MessageRecord, NodeRecord, RunMode, RunRecord, WorkspaceState } from './types';

export type RuntimeStatus = { homes: { id: string; name: string; connected: boolean; model: string; modelCount: number }[]; metrics: { cpuPercent: number | null; gpuPercent: number | null; ramUsedBytes: number; ramTotalBytes: number; measuredAt: string } | null; nodes: NodeRecord[] };
export type BuzzStore = WorkspaceState & { loaded: boolean; online: boolean; runtime?: RuntimeStatus };
const empty: BuzzStore = { uiState: {}, members: [], channels: [], messages: [], runs: [], documents: [], approvals: [], collections: [], rules: '', cursor: 0, loaded: false, online: true };
let state: BuzzStore = empty;
const listeners = new Set<() => void>();
function set(next: BuzzStore) { state = next; listeners.forEach((l) => l()); }
function upsert<T extends { id: string }>(list: T[], item: T): T[] { const i = list.findIndex((x) => x.id === item.id); return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x)); }

const compareMessages = (a: MessageRecord, b: MessageRecord) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function apply(events: EventRecord[]) {
  let s = state;
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case 'conversation.preference': s={...s,hiddenRooms:p.hidden ? [...new Set([...(s.hiddenRooms||[]),String(p.room)])] : (s.hiddenRooms||[]).filter(room=>room!==p.room)}; break;
      case 'channel.created': case 'channel.updated': s = { ...s, channels: s.channels.includes(p.name as string) ? s.channels : [...s.channels, p.name as string], channelDetails: p.channel ? [...(s.channelDetails || []).filter(channel=>channel.name!==p.name),p.channel as import('./types').ChannelRecord] : s.channelDetails }; break;
      case 'workspace.updated': { const key = p.key as string; if (workspaceWrites.has(key) || ev.seq <= (workspaceRevisions.get(key) ?? -1)) break; s = { ...s, uiState: { ...s.uiState, [key]: p.value } }; break; }
      case 'message.created': case 'message.updated': {
        const m = p.message as MessageRecord;
        s = { ...s, hiddenRooms: ev.type==='message.created' && m.room.startsWith('dm:') ? (s.hiddenRooms||[]).filter(room=>room!==m.room) : s.hiddenRooms, messages: upsert(s.messages, m).sort(compareMessages), channels: m.room.startsWith('dm:') || m.room.startsWith('thread:') || s.channels.includes(m.room) ? s.channels : [...s.channels, m.room] };
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
      case 'document.created': case 'document.updated': { const d = p.document as DocumentRecord; s = { ...s, documents: upsert(s.documents, d), collections: s.collections.includes(d.collection) ? s.collections : [...s.collections, d.collection] }; break; }
      case 'document.deleted': s = { ...s, documents: s.documents.filter((d) => d.id !== (p.id as string)) }; break;
      case 'approval.created': case 'approval.updated': s = { ...s, approvals: upsert(s.approvals, p.approval as ApprovalRecord) }; break;
      case 'member.deleted': s = { ...s, members: s.members.filter(member => member.id !== p.id) }; break;
      case 'member.updated': s = { ...s, members: upsert(s.members, p.member as MemberRecord) }; break;
    }
    s = { ...s, cursor: Math.max(s.cursor, ev.seq) };
  }
  if (s !== state) set(s);
}

let started = false, loadRevision = 0;
async function load() {
  const revision = ++loadRevision;
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.status === 401) { window.location.assign('/login'); return; }
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as WorkspaceState;
    if (revision === loadRevision) {
      if (data.cursor < state.cursor) { void load(); return; }
      const incoming = new Set(data.messages.map(message => message.id));
      const visible = new Set(data.historyRooms ?? []);
      const older = state.user?.id === data.user?.id ? state.messages.filter(message => visible.has(message.room) && !incoming.has(message.id)) : [];
      const messages = [...older, ...data.messages].sort(compareMessages);
      set({ ...data, messages, runtime: state.user?.id === data.user?.id ? state.runtime : undefined, loaded: true, online: true });
    }
  } catch { set({ ...state, online: false }); }
}
function connect() {
  const source = new EventSource(`/api/stream?after=${state.cursor}`);
  let sequence = Promise.resolve();
  source.onopen = () => set({...state,online:true});
  source.onerror = () => {if(state.online)set({...state,online:false});};
  source.addEventListener('revoked',()=>{source.close();window.location.assign('/login');});
  source.onmessage = event => {
    sequence = sequence.then(async()=>{
      const data=JSON.parse(event.data) as {events:EventRecord[];cursor:number;reset:boolean};
      if(data.reset){await load();return;}
      apply(data.events.filter(item=>item.seq>state.cursor));
      set({...state,cursor:Math.max(state.cursor,data.cursor),online:true});
    }).catch(()=>{source.close();void load().then(()=>setTimeout(connect,1500));});
  };
}
export function start() { if (started || typeof window === 'undefined') return; started = true; void load().then(connect); }
export function useBuzz(): BuzzStore { start(); return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => empty); }
export function refresh() { return load(); }

// Mutations: every write goes to the API; the event stream brings the durable record back.
export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
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
  history: async (room: string, before?: string) => {
    const userId = state.user?.id;
    const page = await call<{ messages: MessageRecord[]; hasMore: boolean }>(`/api/messages?room=${encodeURIComponent(room)}${before ? '&before=' + encodeURIComponent(before) : ''}`, { method: 'GET' });
    if (state.user?.id === userId && state.historyRooms?.includes(room)) {
      // New stream events win over older history responses for already loaded messages.
      const known = new Set(state.messages.map(message => message.id));
      const messages = [...state.messages, ...page.messages.filter(message => !known.has(message.id))].sort(compareMessages);
      set({ ...state, messages });
    }
    return page;
  },
  cancelRun: (id: string) => call(`/api/runs/${id}/cancel`, { method: 'POST' }),
  saveWorkspaceSetting,
  setConversationHidden: (room:string,hidden:boolean) => call<{room:string;hidden:boolean}>('/api/conversations',{method:'POST',body:JSON.stringify({room,hidden})}).then(result=>apply([{seq:state.cursor,ts:'',type:'conversation.preference',payload:result}])),
  sendMessage: (room: string, text: string, clientId: string, mode: RunMode = 'quick', memberId = 'you') => call<{ message: MessageRecord; runs: string[] }>('/api/messages', { method: 'POST', body: JSON.stringify({ room, text, clientId, memberId, mode }) }).then((r) => { apply([{ seq: state.cursor, ts: r.message.createdAt, type: 'message.created', payload: { message: r.message } }]); return r; }),
  search: (q: string) => call<{ messages: SearchMessage[] }>(`/api/search?q=${encodeURIComponent(q)}`, { method: 'GET' }).then(r => r.messages),
  react: (id: string, emoji: string) => call(`/api/messages/${encodeURIComponent(id)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }).then(() => refresh()),
  retryRun: (retryRunId: string, mode?: RunMode) => call<{ run: RunRecord }>('/api/runs', { method: 'POST', body: JSON.stringify({ retryRunId, mode }) }),
  decide: (id: string, decision: 'Approved' | 'Rejected', action?: string) => call<{ approval: ApprovalRecord }>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision, action }) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'approval.updated', payload: { approval: r.approval } }]); return r.approval; }),
  saveAgent: (agent: Record<string, unknown>) => call<{ member: MemberRecord }>('/api/agents', { method: 'POST', body: JSON.stringify(agent) }).then((r) => { apply([{ seq: state.cursor, ts: '', type: 'member.updated', payload: { member: r.member } }]); return r.member; }),
  deleteAgent: (id: string) => call<{ ok: true }>(`/api/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => apply([{ seq: state.cursor, ts: '', type: 'member.deleted', payload: { id } }])),
  importDocument: async (file: File, meta: { room?: string; collection?: string; level: string; owner?: string; audiences?: string[]; agents?: string[]; readers?: string[] }) => {
    const form = new FormData();
    if(meta.room) form.set('room',meta.room);
    if(file.webkitRelativePath) form.set('relativePath',file.webkitRelativePath);
    form.set('file', file); form.set('collection', meta.collection || 'Files'); form.set('level', meta.level); form.set('owner', meta.owner ?? 'you');
    form.set('readers', JSON.stringify(meta.readers ?? []));
    form.set('audiences', JSON.stringify(meta.audiences ?? [])); if (meta.agents !== undefined) form.set('agents', JSON.stringify(meta.agents));
    const res = await fetch('/api/documents', { method: 'POST', body: form });
    const data = (await res.json().catch(() => null)) as { document: DocumentRecord; error?: string } | null;
    if (!res.ok) throw new Error(data?.error || `Import failed (${res.status}).`);
    apply([{ seq: state.cursor, ts: '', type: 'document.updated', payload: { document: data!.document } }]);
    return data!.document;
  },
  deleteDocument: (id: string) => call<{ ok: true }>(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => apply([{ seq: state.cursor, ts: '', type: 'document.deleted', payload: { id } }])),
  documentUrl: (id: string) => `/api/documents?id=${encodeURIComponent(id)}`,
  runtime: () => call<RuntimeStatus>('/api/runtime', { method: 'GET' }).then((r) => { set({ ...state, runtime: r }); return r; }),
};
