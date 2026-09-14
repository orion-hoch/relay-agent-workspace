import { nativeChildRun } from './native-child';
import type { Database } from '../server/database';
import type { Storage } from '../server/storage';
import type { ApprovalRecord, DocumentRecord, EventRecord, MemberRecord, MessageRecord, RunRecord, WorkspaceState } from './types';

export type BuzzEnv = {
  DB: Database;
  SHOAL_SECRET_KEY?: string;
  BUCKET: Storage;
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
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, initials TEXT NOT NULL, tone TEXT, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY, created_at TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'Internal');
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
CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ingestion_jobs(id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, error TEXT, runner_id TEXT, lease_until TEXT, created_at TEXT NOT NULL);

`;

const initialized = new WeakMap<Database, Promise<void>>();
export function ensureSchema(env: BuzzEnv): Promise<void> {
  let ready = initialized.get(env.DB);
  if (!ready) {
    ready = (async () => {
      await env.DB.exec(SCHEMA.trim());
      await env.DB.migrate();
      if (env.DB.dialect === 'postgres') await env.DB.exec("CREATE INDEX IF NOT EXISTS chunks_fts_search ON chunks_fts USING gin(to_tsvector('simple',text))");
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO members(id,kind,name,initials,data) VALUES ('you','human','You','YO','{}')"),
        env.DB.prepare("INSERT OR IGNORE INTO channels(name,created_at) VALUES ('general',?)").bind(now()),
        env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('rules','Cite your sources. Distinguish observed results from proposals.')"),
      ]);
    })().catch(error => { initialized.delete(env.DB); throw error; });
    initialized.set(env.DB, ready);
  }
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
export const textValue = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '';
const s = (v: unknown) => v == null ? null : textValue(v);
export const mapMember = (r: Row): MemberRecord => ({ id: String(r.id), kind: r.kind as MemberRecord['kind'], name: String(r.name), initials: String(r.initials), tone: s(r.tone) ?? undefined, data: json(s(r.data), {}) });
export const mapMessage = (r: Row): MessageRecord => ({ id: String(r.id), room: String(r.room), memberId: String(r.member_id), name: String(r.name), body: String(r.body), createdAt: String(r.created_at), runId: s(r.run_id), state: s(r.state) as MessageRecord['state'], error: s(r.error), attachment: json(s(r.attachment), null), reactions: json(s(r.reactions), {}) });
export const mapRun = (r: Row, withPacket = false): RunRecord => ({ id: String(r.id), kind: r.kind as RunRecord['kind'], agentId: String(r.agent_id), room: s(r.room), messageId: s(r.message_id), parentRunId: s(r.parent_run_id), status: r.status as RunRecord['status'], mode: r.mode === 'deep' ? 'deep' : 'quick', triggerMessageId: s(r.trigger_message_id), attempt: Number(r.attempt || 0), estimatedInputTokens: r.estimated_input_tokens == null ? null : Number(r.estimated_input_tokens), backend: r.backend as RunRecord['backend'], model: s(r.model), packet: withPacket ? json(s(r.packet), null) : null, result: s(r.result), error: s(r.error), inputTokens: r.input_tokens as number | null, outputTokens: r.output_tokens as number | null, createdAt: String(r.created_at), startedAt: s(r.started_at), endedAt: s(r.ended_at) });
export const mapDocument = (r: Row): DocumentRecord => ({ id: String(r.id), name: String(r.name), type: String(r.type), size: Number(r.size), collection: String(r.collection), sourceRoom: s(r.source_room), relativePath: s(r.relative_path), level: r.level as DocumentRecord['level'], owner: String(r.owner), audiences: json(s(r.audiences), []), agents: json(s(r.agents), []), readers: json(s(r.readers), []), status: r.status as DocumentRecord['status'], textChars: Number(r.text_chars), chunkCount: Number(r.chunk_count), updatedAt: String(r.updated_at), error: s(r.error) });
export const mapApproval = (r: Row): ApprovalRecord => ({ id: String(r.id), runId: s(r.run_id), title: String(r.title), agent: String(r.agent), body: String(r.body), action: String(r.action), source: s(r.source), externalId: s(r.external_id), sessionKey: s(r.session_key), expiresAt: s(r.expires_at), receipt: json(s(r.receipt), null), status: r.status as ApprovalRecord['status'], level: r.level as ApprovalRecord['level'], recipient: String(r.recipient), workflow: String(r.workflow), decidedBy: s(r.decided_by), decidedAt: s(r.decided_at), createdAt: String(r.created_at) });

import { loadPrivacyLayers } from '../server/privacy-layers';

export async function loadState(env: BuzzEnv, rooms?: string[]): Promise<WorkspaceState> {
  await ensureSchema(env);
  const audience = rooms ? `room IN (${rooms.map(() => '?').join(',') || 'NULL'})` : '1=1';
  const [members, channels, messages, runs, documents, approvals, rules, cursor, uiSettings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM members WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id=members.id AND users.removed_at IS NOT NULL) ORDER BY kind, name'),
    env.DB.prepare('SELECT name,display_name,level,agents,topic,description FROM channels ORDER BY created_at'),
    env.DB.prepare(`SELECT * FROM (SELECT * FROM messages WHERE ${audience} ORDER BY created_at DESC, id DESC LIMIT 2000) AS recent ORDER BY created_at, id`).bind(...(rooms ?? [])),
    env.DB.prepare(`SELECT * FROM runs WHERE ${audience} OR room IS NULL ORDER BY created_at DESC LIMIT 200`).bind(...(rooms ?? [])),
    env.DB.prepare('SELECT * FROM documents ORDER BY updated_at DESC'),
    env.DB.prepare('SELECT * FROM approvals ORDER BY created_at DESC'),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'rules'"),
    env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events'),
    env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'ui:%'"),
  ]);
  const docs = (documents.results as Row[]).map(mapDocument);
  const parents = (runs.results as Row[]).map(row => mapRun(row));
  const observations = await env.DB.prepare("SELECT run_id, payload FROM run_events WHERE type='tool' AND json_extract(payload,'$.name') IN ('native.agent','direct.agent') AND run_id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 200) ORDER BY id").all<{ run_id: string; payload: string }>();
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
    channelDetails: (channels.results as Row[]).map(r=>({name:String(r.name),displayName:textValue(r.display_name)||String(r.name),level:String(r.level),topic:textValue(r.topic),description:textValue(r.description),agents:r.agents===null?null:json<string[]>(textValue(r.agents),[])})),
    messages: (messages.results as Row[]).map(mapMessage),
    runs: [...parents, ...nativeRuns.values()],
    documents: docs,
    privacyLayers: await loadPrivacyLayers(env),
    approvals: (approvals.results as Row[]).map(mapApproval),
    collections: [...new Set(docs.map((d) => d.collection))],
    rules: textValue((rules.results[0] as Row | undefined)?.value),
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
