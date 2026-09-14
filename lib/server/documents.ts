import { id, now, mapDocument, emit, type BuzzEnv } from '../buzz/db';
import { validateSourcePolicy } from './privacy-layers';
export async function storeDocument(env: BuzzEnv, owner: string, file: File, options: {collection?: string; level?: string; readers?: string[]; audiences?: string[]; agents?: string[]; room?: string; sourceRoom?: string; relativePath?: string; authorName?: string} = {}) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Files over 25 MB are not supported.');
  const level = options.level || 'Internal';
  const doc = { id: id('doc'), name: (file.name.split(/[\\/]/).pop() || 'file').replaceAll('\r','_').replaceAll('\n','_').slice(0, 200), type: file.type || 'application/octet-stream', size: file.size, collection: String(options.collection || 'Files').slice(0, 80), level, owner: owner, readers: options.readers || [], audiences: options.audiences || [], agents: options.agents ?? ['*'], r2_key: '' };
  await validateSourcePolicy(env, level, doc.agents);
  doc.r2_key = `documents/${doc.id}/${doc.name}`;
  const bytes = await file.arrayBuffer();
  await env.BUCKET.put(doc.r2_key, bytes, { httpMetadata: { contentType: doc.type } });
  const message = options.room ? {id:id('msg'),room:options.room,memberId:owner,name:options.authorName || 'Teammate',body:'',createdAt:now(),attachment:{name:doc.name,detail:level,documentId:doc.id}} : null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO documents(id, name, type, size, collection, level, owner, audiences, agents, readers, status, updated_at, r2_key, source_room, relative_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracting', ?, ?, ?, ?)")
      .bind(doc.id, doc.name, doc.type, doc.size, doc.collection, doc.level, doc.owner, JSON.stringify(doc.audiences), JSON.stringify(doc.agents), JSON.stringify(doc.readers), now(), doc.r2_key,options.sourceRoom || null,options.relativePath || null),
    env.DB.prepare("INSERT INTO ingestion_jobs(id,document_id,status,created_at) VALUES (?,?,'queued',?)").bind(id('ingest'), doc.id, now()),
    ...(message ? [env.DB.prepare('INSERT INTO messages(id,room,member_id,name,body,created_at,attachment) VALUES (?,?,?,?,?,?,?)').bind(message.id,message.room,owner,message.name,'',message.createdAt,JSON.stringify(message.attachment))] : []),
  ]);
  const document = mapDocument((await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(doc.id).first<Record<string, unknown>>())!);
  await emit(env, 'document.created', { document });
  if(message) await emit(env,'message.created',{message});
  return document;
}
