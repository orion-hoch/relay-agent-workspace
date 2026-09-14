import { randomUUID } from 'node:crypto';
import { env } from '../lib/server/env';
import { ensureSchema, emit, mapDocument, now } from '../lib/buzz/db';
import { indexDocument } from '../lib/server/ingestion';
const e = env;
const worker = randomUUID();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
await ensureSchema(e);
console.log('Shoal document worker ready.');
for (;;) {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let job: { id: string; document_id: string } | null = null;
  try {
    job = await e.DB.prepare("UPDATE ingestion_jobs SET status='running',runner_id=?,lease_until=? WHERE id=(SELECT id FROM ingestion_jobs WHERE status='queued' OR (status='running' AND lease_until<?) ORDER BY created_at LIMIT 1) AND (status='queued' OR lease_until<?) RETURNING id,document_id").bind(worker, new Date(Date.now() + 120000).toISOString(), now(), now()).first();
    if (!job) { await sleep(1000); continue; }
    const jobId = job.id;
    heartbeat = setInterval(() => { void e.DB.prepare('UPDATE ingestion_jobs SET lease_until=? WHERE id=? AND runner_id=?').bind(new Date(Date.now() + 120000).toISOString(), jobId, worker).run().catch(error => console.error('Ingestion heartbeat failed:', error.message)); }, 20000);
    await indexDocument(e, job.document_id);
    await e.DB.prepare("UPDATE ingestion_jobs SET status='completed',error=NULL,lease_until=NULL WHERE id=? AND runner_id=?").bind(job.id, worker).run();
    console.log(`Processed ${job.document_id}.`);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Document processing failed.';
    console.error(error);
    if (job) {
      await e.DB.batch([
        e.DB.prepare("UPDATE ingestion_jobs SET status='failed',error=?,lease_until=NULL WHERE id=? AND runner_id=?").bind(error, job.id, worker),
        e.DB.prepare("UPDATE documents SET status=CASE WHEN chunk_count>0 THEN 'ready' ELSE 'failed' END,error=? WHERE id=?").bind(error, job.document_id),
      ]);
      const document = await e.DB.prepare('SELECT * FROM documents WHERE id=?').bind(job.document_id).first<Record<string, unknown>>();
      if (document) await emit(e, 'document.updated', { document: mapDocument(document) });
    }
    await sleep(1000);
  } finally { if (heartbeat) clearInterval(heartbeat); }
}
