import type { BuzzEnv } from '../buzz/db';
import { emit, mapDocument, now } from '../buzz/db';
import { chunkText, embed } from '../buzz/context';
import { retrievalEnvironment } from '../buzz/models';

async function readText(name: string, type: string, bytes: Uint8Array): Promise<string | null> {
  if (/\.(txt|md|markdown|csv|tsv|json|ya?ml|log|py|tsx?|jsx?|mjs|html|css|sql|sh|toml|ini|cfg|rst)$/i.test(name) || /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/.test(type)) return new TextDecoder().decode(bytes);
  if (/\.docx$/i.test(name)) {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  }
  if (/\.pdf$/i.test(name)) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const document = await task.promise;
    try {
      if (document.numPages > 1000) throw new Error('PDFs over 1,000 pages are not supported. Split the document.');
      const pages: string[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
      }
      return pages.join('\n\n');
    } finally { await task.destroy(); }
  }
  return null;
}

export async function extractText(name: string, type: string, bytes: Uint8Array): Promise<string | null> {
  const text = await readText(name, type, bytes);
  if (text !== null && !text.trim()) throw new Error('No text extracted. Scanned PDFs need OCR before upload.');
  return text;
}

export async function indexDocument(e: BuzzEnv, documentId: string) {
  const stored = await e.DB.prepare('SELECT * FROM documents WHERE id=?').bind(documentId).first<Record<string, unknown>>();
  if (!stored) throw new Error('The document was removed.');
  const pending = typeof stored.pending_source === 'string' ? JSON.parse(stored.pending_source) as Record<string, unknown> : null;
  const row = { ...stored, ...pending };
  const object = await e.BUCKET.get(String(row.r2_key));
  if (!object) throw new Error('Stored file is missing.');
  const text = await extractText(String(row.name), String(row.type), new Uint8Array(await object.arrayBuffer()));
  if (text !== null && text.length > 10000000) throw new Error('Extracted text exceeds 10 million characters. Split the document.');
  const chunks = text === null ? [] : chunkText(text);
  const env = chunks.length ? await retrievalEnvironment(e) : e;
  const vectors: (number[] | null)[] = [];
  let degraded = false;
  for (let index = 0; index < chunks.length; index += 32) {
    const batch = chunks.slice(index, index + 32);
    const embedded = await embed(env, batch);
    if (!embedded || embedded.length !== batch.length) degraded = true;
    vectors.push(...batch.map((_, i) => embedded?.[i] ?? null));
  }
  // Replace the index in one transaction. A failed refresh keeps its old index.
  const statements = [e.DB.prepare('DELETE FROM chunks_fts WHERE document_id=?').bind(documentId), e.DB.prepare('DELETE FROM chunks WHERE document_id=?').bind(documentId)];
  chunks.forEach((text, index) => {
    const chunkId = `${documentId}:${index}`;
    statements.push(e.DB.prepare('INSERT INTO chunks(id,document_id,idx,text,embedding) VALUES (?,?,?,?,?)').bind(chunkId, documentId, index, text, vectors[index] ? JSON.stringify(vectors[index]) : null), e.DB.prepare('INSERT INTO chunks_fts(chunk_id,document_id,text) VALUES (?,?,?)').bind(chunkId, documentId, text));
  });
  if (pending) statements.push(e.DB.prepare('UPDATE documents SET name=?,size=?,level=?,agents=?,r2_key=?,pending_source=NULL WHERE id=?').bind(row.name, row.size, row.level, row.agents, row.r2_key, documentId));
  statements.push(e.DB.prepare("UPDATE documents SET status=?,text_chars=?,chunk_count=?,error=?,updated_at=? WHERE id=?").bind(text === null ? 'stored' : 'ready', text?.length ?? 0, chunks.length, degraded ? 'Keyword search only: embeddings unavailable. Retry indexing after connecting an embedding model.' : null, now(), documentId));
  await e.DB.batch(statements);
  if (pending && stored.r2_key !== row.r2_key) await e.BUCKET.delete(String(stored.r2_key)).catch(() => {});
  const updated = await e.DB.prepare('SELECT * FROM documents WHERE id=?').bind(documentId).first<Record<string, unknown>>();
  if (updated) await emit(e, 'document.updated', { document: mapDocument(updated) });
}
