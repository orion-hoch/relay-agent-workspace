import { nativeChildRun } from './native-child';
import { cleanDemoProfiles } from './profile-cleanup';
import { renameShellDemo } from './shell-demo';
import { BELL_COLLECTIONS, seedBell } from './bell-seed';
import type { ApprovalRecord, DocumentRecord, EventRecord, MemberRecord, MessageRecord, NodeRecord, RunRecord, TaskRecord, WorkspaceState } from './types';

export type BuzzEnv = {
  DB: D1Database;
  BUCKET: R2Bucket;
  BUZZ_VLLM_URL?: string; // e.g. http://127.0.0.1:8000/v1
  BUZZ_VLLM_TOKEN?: string;
  BUZZ_NODE_NAME?: string;
  BUZZ_MODEL?: string; // served model name, e.g. gemma
  BUZZ_EMBED_URL?: string; // http://127.0.0.1:8001/v1
  BUZZ_EMBED_MODEL?: string;
  BUZZ_EMBED_TOKEN?: string;
  BUZZ_RERANK_URL?: string; // http://127.0.0.1:8002
  BUZZ_RERANK_MODEL?: string;
  BUZZ_RERANK_TOKEN?: string;
  BUZZ_OPENCLAW_URL?: string; // http://127.0.0.1:18789
  BUZZ_OPENCLAW_TOKEN?: string;
  BUZZ_OPENCLAW_AGENT?: string;
  BUZZ_RUNNER_TOKEN?: string; // shared secret for the runner endpoints
  BUZZ_WORKER_BUDGET?: string; // input tokens per chat/subtask run
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, initials TEXT NOT NULL, tone TEXT, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, room TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT, state TEXT, error TEXT, client_id TEXT UNIQUE, attachment TEXT);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room, created_at);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#5b8def');
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'Medium', due TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', comments TEXT NOT NULL DEFAULT '[]', deliverable TEXT, parent_id TEXT, criteria TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT NOT NULL, room TEXT, message_id TEXT, task_id TEXT, parent_run_id TEXT, status TEXT NOT NULL, backend TEXT NOT NULL, model TEXT, packet TEXT, result TEXT, error TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, mode TEXT NOT NULL DEFAULT 'quick', trigger_message_id TEXT, attempt INTEGER NOT NULL DEFAULT 0, runner_id TEXT, lease_until TEXT, last_seq INTEGER NOT NULL DEFAULT 0, estimated_input_tokens INTEGER);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
CREATE TABLE IF NOT EXISTS run_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, collection TEXT NOT NULL, level TEXT NOT NULL, owner TEXT NOT NULL, audiences TEXT NOT NULL DEFAULT '[]', agents TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, text_chars INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, r2_key TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, embedding TEXT);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, idx);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, document_id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, agent TEXT NOT NULL, body TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, level TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT '', workflow TEXT NOT NULL DEFAULT '', decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL, source TEXT, external_id TEXT, session_key TEXT, expires_at TEXT, receipt TEXT);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let ready: Promise<void> | null = null;
export function ensureSchema(env: BuzzEnv): Promise<void> {
  // ponytail: schema bootstrap on first request per isolate; migrations when the schema stops being additive.
  ready ??= (async () => {
    await env.DB.exec(SCHEMA.trim().split('\n').filter(Boolean).join('\n'));
    await seedBell(env);
    await renameShellDemo(env);
    await cleanDemoProfiles(env);
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const json = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; } };

export async function emit(env: BuzzEnv, type: string, payload: Record<string, unknown>): Promise<number> {
  const row = await env.DB.prepare('INSERT INTO events(ts, type, payload) VALUES (?, ?, ?) RETURNING seq').bind(now(), type, JSON.stringify(payload)).first<{ seq: number }>();
  return row?.seq ?? 0;
}

export async function eventsAfter(env: BuzzEnv, after: number, limit = 500): Promise<EventRecord[]> {
  const { results } = await env.DB.prepare('SELECT seq, ts, type, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?').bind(after, limit).all<{ seq: number; ts: string; type: string; payload: string }>();
  return results.map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, payload: json(r.payload, {}) }));
}

// Row mappers -------------------------------------------------------------
type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? null : String(v));
export const mapMember = (r: Row): MemberRecord => ({ id: String(r.id), kind: r.kind as MemberRecord['kind'], name: String(r.name), initials: String(r.initials), tone: s(r.tone) ?? undefined, data: json(s(r.data), {}) });
export const mapMessage = (r: Row): MessageRecord => ({ id: String(r.id), room: String(r.room), memberId: String(r.member_id), name: String(r.name), body: String(r.body), createdAt: String(r.created_at), runId: s(r.run_id), state: s(r.state) as MessageRecord['state'], error: s(r.error), attachment: json(s(r.attachment), null) });
export const mapTask = (r: Row): TaskRecord => ({ id: String(r.id), project: String(r.project), title: String(r.title), description: String(r.description), status: String(r.status), owner: String(r.owner), priority: String(r.priority), due: String(r.due), label: String(r.label), comments: json(s(r.comments), []), deliverable: s(r.deliverable), parentId: s(r.parent_id), criteria: s(r.criteria), createdAt: String(r.created_at) });
export const mapRun = (r: Row, withPacket = false): RunRecord => ({ id: String(r.id), kind: r.kind as RunRecord['kind'], agentId: String(r.agent_id), room: s(r.room), messageId: s(r.message_id), taskId: s(r.task_id), parentRunId: s(r.parent_run_id), status: r.status as RunRecord['status'], mode: r.mode === 'deep' ? 'deep' : 'quick', triggerMessageId: s(r.trigger_message_id), attempt: Number(r.attempt || 0), estimatedInputTokens: r.estimated_input_tokens == null ? null : Number(r.estimated_input_tokens), backend: r.backend as RunRecord['backend'], model: s(r.model), packet: withPacket ? json(s(r.packet), null) : null, result: s(r.result), error: s(r.error), inputTokens: r.input_tokens as number | null, outputTokens: r.output_tokens as number | null, createdAt: String(r.created_at), startedAt: s(r.started_at), endedAt: s(r.ended_at) });
export const mapDocument = (r: Row): DocumentRecord => ({ id: String(r.id), name: String(r.name), type: String(r.type), size: Number(r.size), collection: String(r.collection), level: r.level as DocumentRecord['level'], owner: String(r.owner), audiences: json(s(r.audiences), []), agents: json(s(r.agents), []), status: r.status as DocumentRecord['status'], textChars: Number(r.text_chars), chunkCount: Number(r.chunk_count), updatedAt: String(r.updated_at), error: s(r.error) });
export const mapApproval = (r: Row): ApprovalRecord => ({ id: String(r.id), runId: s(r.run_id), title: String(r.title), agent: String(r.agent), body: String(r.body), action: String(r.action), source: s(r.source), externalId: s(r.external_id), sessionKey: s(r.session_key), expiresAt: s(r.expires_at), receipt: json(s(r.receipt), null), status: r.status as ApprovalRecord['status'], level: r.level as ApprovalRecord['level'], recipient: String(r.recipient), workflow: String(r.workflow), decidedBy: s(r.decided_by), decidedAt: s(r.decided_at), createdAt: String(r.created_at) });
export const mapNode = (r: Row): NodeRecord => ({ id: String(r.id), name: String(r.name), kind: r.kind as NodeRecord['kind'], status: String(r.status), data: json(s(r.data), {}), seenAt: String(r.seen_at) });

export async function loadState(env: BuzzEnv): Promise<WorkspaceState> {
  await ensureSchema(env);
  const [members, channels, messages, projects, tasks, runs, documents, approvals, nodes, rules, cursor, uiSettings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM members ORDER BY kind, name'),
    env.DB.prepare('SELECT name FROM channels ORDER BY created_at'),
    env.DB.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 2000) ORDER BY created_at'),
    env.DB.prepare('SELECT * FROM projects ORDER BY name'),
    env.DB.prepare('SELECT * FROM tasks ORDER BY created_at'),
    env.DB.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 200'),
    env.DB.prepare('SELECT * FROM documents ORDER BY updated_at DESC'),
    env.DB.prepare('SELECT * FROM approvals ORDER BY created_at DESC'),
    env.DB.prepare('SELECT * FROM nodes ORDER BY name'),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'rules'"),
    env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events'),
    env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'ui:%'"),
  ]);
  const docs = (documents.results as Row[]).map(mapDocument);
  const parents = (runs.results as Row[]).map(row => mapRun(row));
  const observations = await env.DB.prepare("SELECT run_id, payload FROM run_events WHERE type='tool' AND json_extract(payload,'$.name')='native.agent' AND run_id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 200) ORDER BY id").all<{ run_id: string; payload: string }>();
  const nativeRuns = new Map<string, RunRecord>();
  for (const observation of observations.results) {
    const parent = parents.find(run => run.id === observation.run_id);
    if (!parent) continue;
    const child = nativeChildRun(parent, json<{ output?: unknown }>(observation.payload, {}).output);
    if (child) nativeRuns.set(child.id, child);
  }
  return {
    uiState: Object.fromEntries((uiSettings.results as { key: string; value: string }[]).map(row => [row.key.slice(3), json(row.value, null)])),
    members: (members.results as Row[]).map(mapMember),
    channels: (channels.results as Row[]).map((r) => String(r.name)),
    messages: (messages.results as Row[]).map(mapMessage),
    projects: projects.results as WorkspaceState['projects'],
    tasks: (tasks.results as Row[]).map(mapTask),
    runs: [...parents, ...nativeRuns.values()],
    documents: docs,
    approvals: (approvals.results as Row[]).map(mapApproval),
    nodes: (nodes.results as Row[]).map(mapNode),
    collections: [...new Set([...BELL_COLLECTIONS, ...docs.map((d) => d.collection)])],
    rules: String((rules.results[0] as Row | undefined)?.value ?? ''),
    cursor: Number((cursor.results[0] as Row).seq),
  };
}

export function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function ok(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function body<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try { const v = await request.json(); return v && typeof v === 'object' ? (v as T) : null; } catch { return null; }
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
export function runnerAuthorized(request: Request, env: BuzzEnv): boolean {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return !!env.BUZZ_RUNNER_TOKEN && token === env.BUZZ_RUNNER_TOKEN;
}
