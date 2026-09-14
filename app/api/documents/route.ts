import { storeDocument } from '@/lib/server/documents';
import { actor } from '@/lib/server/team';
import { canonicalRoom, publicRoom, documentFor } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { textValue, body, emit, fail, mapDocument, now, ok } from '@/lib/buzz/db';
import { loadPrivacyLayers, validateSourcePolicy } from '@/lib/server/privacy-layers';
import { dmMembers, resolveContextRoom } from '@/lib/buzz/context-scope';
export const dynamic = 'force-dynamic';

// Store the upload and queue durable extraction/indexing for the document worker.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return fail('Choose a file to import.');
  if (file.size > 25 * 1024 * 1024) return fail('Files over 25 MB are not supported yet.', 413);
  const level = textValue(form!.get('level') || 'Internal');
  const parse = (v: FormDataEntryValue | null) => { try { const x = JSON.parse(textValue(v ?? '[]')); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  const user=actor(request);
  const requestedRoom=textValue(form!.get('room') || '');
  const room=requestedRoom ? await canonicalRoom(env,user,requestedRoom) : null;
  if(requestedRoom && !room) return fail('Conversation not found or access denied.',404);
  const sourceRoom=room ? await resolveContextRoom(env,room) : null;
  const author=room ? await env.DB.prepare('SELECT name FROM members WHERE id=?').bind(user.id).first<{name:string}>() : null;
  const relativePath=textValue(form!.get('relativePath') || '');
  if(relativePath.length>1000 || relativePath.split(/[\\/]/).some(part=>part==='..') || Array.from(relativePath).some(char=>char.charCodeAt(0)<32)) return fail('Invalid folder path.');
  try {
    const document = await storeDocument(env, actor(request).id, file, {level, collection: textValue(form!.get('collection') || 'Files'), room:room || undefined,sourceRoom:sourceRoom || undefined,relativePath,authorName:author?.name,readers:sourceRoom ? sourceRoom.startsWith('dm:') ? dmMembers(sourceRoom) : ['*'] : parse(form!.get('readers')), audiences: parse(form!.get('audiences')), agents: form!.has('agents') ? parse(form!.get('agents')) : undefined});
    return ok({document:{...document,sourceRoom:sourceRoom ? publicRoom(sourceRoom,user.id) : null}}, 202);
  } catch (error) { return fail(error instanceof Error ? error.message : 'Import failed.'); }
}

// GET ?id=… → original bytes (preview/download). DELETE ?id=… → remove document, chunks, index, and bytes.
export async function GET(request: Request) {
  const docId = new URL(request.url).searchParams.get('id');
  const row = docId ? await documentFor(env,actor(request),docId,false) : null;
  if (!row) return fail('Document not found.', 404);
  const object = await env.BUCKET.get(textValue(row.r2_key));
  if (!object) return fail('Stored bytes are missing.', 404);
  return new Response(object.body, { headers: { 'Content-Type': String(row.type), 'Content-Disposition': `${new URL(request.url).searchParams.get('preview') === '1' ? 'inline' : 'attachment'}; filename="${String(row.name).replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox" } });
}
export async function DELETE(request: Request) {
  const docId = new URL(request.url).searchParams.get('id');
  const row = docId ? await documentFor(env,actor(request),docId,true) : null;
  if (!row) return fail('Document not found.', 404);
  if (await env.DB.prepare("SELECT id FROM ingestion_jobs WHERE document_id=? AND status='running'").bind(docId).first()) return fail('Wait for indexing to finish before removing this document.', 409);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ingestion_jobs WHERE document_id = ?').bind(docId),
    env.DB.prepare('DELETE FROM chunks_fts WHERE document_id = ?').bind(docId),
    env.DB.prepare('DELETE FROM chunks WHERE document_id = ?').bind(docId),
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(docId),
  ]);
  if (row.r2_key) await env.BUCKET.delete(textValue(row.r2_key));
  await emit(env, 'document.deleted', { id: docId });
  return ok({ ok: true });
}

// Update source policy without changing stored bytes or its retrieval index.
export async function PATCH(request: Request) {
  const input = await body<{ id?: string; level?: string; collection?: string; audiences?: string[]; agents?: string[]; readers?: string[] }>(request);
  if (!input?.id) return fail('Choose a document.');
  if (input.level !== undefined && !(await loadPrivacyLayers(env)).some(layer => layer.name === input.level)) return fail('Choose a valid classification.');
  if (input.collection !== undefined && (typeof input.collection !== 'string' || !input.collection.trim() || input.collection.trim().length > 80)) return fail('Collection names must contain 1–80 characters.');
  for (const key of ['audiences', 'agents','readers'] as const) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key]!.length > 100 || input[key]!.some(value => typeof value !== 'string' || !value.trim() || value.length > 300))) return fail(`Choose valid ${key}.`);
  }
  const row = await documentFor(env,actor(request),input.id,true);
  if (!row) return fail('Document not found.', 404);
  if (row.pending_source && (input.level !== undefined || input.agents !== undefined)) return fail('Wait for the database snapshot refresh to finish before changing its policy.', 409);
  const document = mapDocument(row);
  const level = input.level ?? document.level;
  const collection = input.collection?.trim() ?? document.collection;
  const audiences = input.audiences === undefined ? document.audiences : [...new Set(input.audiences.map(value => value.trim()))];
  const readers=input.readers===undefined ? document.readers || [] : [...new Set(input.readers)];
  const agents = input.agents === undefined ? document.agents : [...new Set(input.agents)];
  if (input.level !== undefined || input.agents !== undefined) {
    try { await validateSourcePolicy(env, level, agents); }
    catch (error) { return fail(error instanceof Error ? error.message : 'Invalid source policy.'); }
  }
  await env.DB.prepare('UPDATE documents SET level = ?, collection = ?, audiences = ?, agents = ?, readers = ?, updated_at = ? WHERE id = ?')
    .bind(level, collection, JSON.stringify(audiences), JSON.stringify(agents), JSON.stringify(readers), now(), input.id).run();
  const updated = mapDocument((await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(input.id).first<Record<string, unknown>>())!);
  await emit(env, 'document.updated', { document: updated });
  return ok({ document: updated });
}
