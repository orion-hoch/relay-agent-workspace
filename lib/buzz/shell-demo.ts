import type { BuzzEnv } from './db';
import { embed } from './context';

// Keep stable document/task IDs and existing user edits while renaming the fictional tenant.
export async function renameShellDemo(env: BuzzEnv) {
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'shell_demo_v1'").first()) return;
  const rename = (text: string) => text.replace(/\bBell\b/g, 'Shell');
  const chunks = await env.DB.prepare("SELECT id, document_id, text FROM chunks WHERE document_id LIKE 'bell-%' AND text LIKE '%Bell%'").all<{ id: string; document_id: string; text: string }>();
  const texts = chunks.results.map(chunk => rename(chunk.text));
  const vectors = texts.length ? await embed(env, texts) : null;
  const statements: D1PreparedStatement[] = [];
  for (const [index, chunk] of chunks.results.entries()) {
    statements.push(env.DB.prepare('UPDATE chunks SET text = ?, embedding = ? WHERE id = ?').bind(texts[index], vectors ? JSON.stringify(vectors[index]) : null, chunk.id));
    statements.push(env.DB.prepare('UPDATE chunks_fts SET text = ? WHERE chunk_id = ?').bind(texts[index], chunk.id));
    const doc = await env.DB.prepare('SELECT r2_key FROM documents WHERE id = ?').bind(chunk.document_id).first<{ r2_key: string }>();
    if (doc?.r2_key) {
      const source = await env.BUCKET.get(doc.r2_key);
      if (source) {
        const text = rename(await source.text());
        await env.BUCKET.put(doc.r2_key, text, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
        statements.push(env.DB.prepare('UPDATE documents SET size = ?, text_chars = ?, error = ? WHERE id = ?').bind(new TextEncoder().encode(text).length, text.length, vectors ? null : 'Keyword search only: demo embeddings unavailable.', chunk.document_id));
      }
    }
  }
  statements.push(
    env.DB.prepare("UPDATE members SET data = replace(data, 'Bell', 'Shell') WHERE json_extract(data, '$.demo') = 1"),
    env.DB.prepare("UPDATE documents SET audiences = replace(audiences, 'Bell Engineering', 'Shell Engineering'), error = replace(error, 'Bell demo', 'Shell demo') WHERE id LIKE 'bell-%'"),
    env.DB.prepare("UPDATE messages SET body = replace(body, 'Bell', 'Shell') WHERE id LIKE 'bell-message-%'"),
    env.DB.prepare("UPDATE approvals SET workflow = replace(workflow, 'Bell', 'Shell') WHERE source = 'bell-demo'"),
    env.DB.prepare("INSERT INTO settings(key, value) VALUES ('shell_demo_v1', '1')")
  );
  await env.DB.batch(statements);
}
