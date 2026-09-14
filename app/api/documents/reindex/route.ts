import { actor } from '@/lib/server/team';
import { documentFor } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, fail, id, now, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const input = await body<{ id?: string }>(request);
  if (!input?.id || !await documentFor(env,actor(request),input.id,true)) return fail('Document not found.', 404);
  if (await env.DB.prepare("SELECT id FROM ingestion_jobs WHERE document_id=? AND status IN ('running','queued')").bind(input.id).first()) return fail('This document is already queued or indexing.', 409);
  await env.DB.prepare("INSERT INTO ingestion_jobs(id,document_id,status,created_at) VALUES (?,?,'queued',?) ON CONFLICT(document_id) DO UPDATE SET status='queued',error=NULL,created_at=excluded.created_at").bind(id('ingest'), input.id, now()).run();
  return ok({ queued: true }, 202);
}
