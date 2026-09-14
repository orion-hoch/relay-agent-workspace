import { assertEndpoint } from '@/lib/server/network';
import { actor } from '@/lib/server/team';
import { env } from '@/lib/server/env';
import { body, textValue, emit, fail, id, mapDocument, now, ok } from '@/lib/buzz/db';
import { seal, unseal } from '@/lib/buzz/secrets';
import { readSource, type SourceKind, type SourceSelection } from '@/lib/server/sources';
import { validateSourcePolicy } from '@/lib/server/privacy-layers';

type Input = { id?: string; name?: string; engine?: SourceKind; address?: string; action?: string; selection?: SourceSelection; agents?: string[]; level?: string };
type Config = { engine: SourceKind; selection?: SourceSelection; documentId?: string; syncedAt?: string };
export const dynamic = 'force-dynamic';
export async function GET() {
  const rows = await env.DB.prepare("SELECT c.id,c.name,c.config,d.level,d.agents,d.readers,d.error,COALESCE(j.status,d.status) AS status FROM connections c LEFT JOIN documents d ON d.id=json_extract(c.config,'$.documentId') LEFT JOIN ingestion_jobs j ON j.document_id=d.id WHERE c.kind='database' ORDER BY c.created_at").all<{ id: string; name: string; config: string; level: string | null; agents: string | null; readers: string | null; status: string | null; error: string | null }>();
  return ok({ sources: rows.results.map(row => ({ id: row.id, name: row.name, ...JSON.parse(row.config) as Config, level: row.level || 'Internal', status: row.status, error: row.error, shared: (JSON.parse(row.readers || '[]') as string[]).includes('*'), agents: JSON.parse(row.agents || '["*"]') as string[] })) });
}
export async function POST(request: Request) {
  const p = await body<Input>(request);
  if (!p) return fail('Provide database connection settings.');
  const existing = p.id ? await env.DB.prepare("SELECT id,name,config,secret FROM connections WHERE id=? AND kind='database'").bind(p.id).first<{ id: string; name: string; config: string; secret: string }>() : null;
  if (p.id && !existing) return fail('Source not found.', 404);
  const config = existing ? JSON.parse(existing.config) as Config : null;
  const engine = config?.engine || p.engine;
  if (!engine || !['postgres','mysql','sqlite'].includes(engine)) return fail('Choose PostgreSQL, MySQL, or SQLite.');
  try {
    const address = p.address?.trim() || (existing ? await unseal(env, existing.secret) : '');
    if (!address || address.length > 8192) return fail('Provide the database URL or SQLite filename.');
    if (engine!=='sqlite') await assertEndpoint(env,address);
    if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80)) return fail('Use a name of 1–80 characters.');
    const sourceName = p.name?.trim() || existing?.name;
    const selection = p.selection || config?.selection;
    const connected = p.action === 'connect' ? await readSource(engine, address) : null;
    if (p.action === 'test') return ok(await readSource(engine, address));
    if (p.action === 'preview' || p.action === 'import') {
      if (!selection || !Array.isArray(selection.columns) || selection.columns.length > 200) return fail('Choose a table and columns.');
      const result = await readSource(engine, address, { ...selection, limit: p.action === 'preview' ? 10 : selection.limit });
      if (p.action === 'preview') return ok(result);
      if (!existing) return fail('Save the connection before importing.');
      const documentId = config?.documentId || id('doc');
      const previous = await env.DB.prepare('SELECT id,level,agents FROM documents WHERE id=?').bind(documentId).first<{ id: string; level: string; agents: string }>();
      const level = p.level ?? previous?.level ?? 'Internal';
      const grants = p.agents ?? JSON.parse(previous?.agents || '["*"]') as string[];
      try { await validateSourcePolicy(env, level, grants); }
      catch (error) { return fail(error instanceof Error ? error.message : 'Invalid source policy.'); }
      if (await env.DB.prepare("SELECT id FROM ingestion_jobs WHERE document_id=? AND status IN ('queued','running')").bind(documentId).first()) return fail('This source is already being indexed.', 409);
      const stamp = now();
      const name = `${sourceName} — ${selection.schema ? selection.schema + '.' : ''}${selection.table}.md`;
      const text = `# ${name}\nRead-only snapshot at ${stamp}. ${result.rows.length} rows${result.truncated ? '; row limit reached, snapshot is incomplete' : ''}.\n\n` + result.rows.map((row, index) => `## Row ${index + 1}\n` + Object.entries(row).map(([column, value]) => `${column}: ${typeof value === 'object' ? JSON.stringify(value) : textValue(value ?? '')}`).join('\n')).join('\n\n');
      if (Buffer.byteLength(text) > 10 * 1024 * 1024) return fail('Snapshot exceeds 10 MB. Select fewer rows or columns.');
      const key = `sources/${documentId}/${crypto.randomUUID()}.md`;
      await env.BUCKET.put(key, text, { httpMetadata: { contentType: 'text/markdown' } });
      const pending = { name, size: Buffer.byteLength(text), level, agents: JSON.stringify(grants), r2_key: key };
      const documentWrite = previous
        ? env.DB.prepare('UPDATE documents SET pending_source=? WHERE id=?').bind(JSON.stringify(pending), documentId)
        : env.DB.prepare("INSERT INTO documents(id,name,type,size,collection,level,owner,audiences,agents,status,updated_at,r2_key) VALUES (?,?,'text/markdown',?,'Database sources',?,?,'[]',?,'extracting',?,?)")
          .bind(documentId, name, Buffer.byteLength(text), level, actor(request).id, JSON.stringify(grants), stamp, key);
      await env.DB.batch([
        documentWrite,
        env.DB.prepare("INSERT INTO ingestion_jobs(id,document_id,status,created_at) VALUES (?,?,'queued',?) ON CONFLICT(document_id) DO UPDATE SET status='queued',error=NULL,created_at=excluded.created_at").bind(id('ingest'), documentId, stamp),
        env.DB.prepare('UPDATE connections SET name=?,config=? WHERE id=?').bind(sourceName, JSON.stringify({ engine, selection, documentId, syncedAt: stamp }), existing.id),
      ]);
      const document = mapDocument((await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(documentId).first<Record<string, unknown>>())!);
      await emit(env, 'document.updated', { document });
      return ok({ document, rows: result.rows.length, truncated: result.truncated }, 202);
    }
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) return fail('Enter a connection name.');
    const connectionId = p.id || id('source');
    await env.DB.prepare("INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,'database',?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,secret=excluded.secret").bind(connectionId, p.name.trim(), JSON.stringify({ engine }), await seal(env, address), now()).run();
    return ok({ id: connectionId, ...connected });
  } catch (cause) {
    console.error('Source operation failed:', cause instanceof Error ? cause.name : 'UnknownError');
    return fail(engine === 'sqlite' ? 'Could not read this SQLite file. Check its name and the server’s sources folder.' : 'Could not read this database. Check the URL and read permissions.', 502);
  }
}
export async function DELETE(request: Request) {
  const sourceId = new URL(request.url).searchParams.get('id');
  if (!sourceId) return fail('Choose a source.');
  await env.DB.prepare("DELETE FROM connections WHERE id=? AND kind='database'").bind(sourceId).run();
  return ok({ ok: true, message: 'Connection removed. Imported snapshots remain in Data until you remove them.' });
}
