import { actor, isAdmin } from '@/lib/server/team';
import { canReadRun } from '@/lib/server/access';
import { env } from '@/lib/server/env';
import { body, emit, fail, mapApproval, now, ok } from '@/lib/buzz/db';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = await body<{ decision?: string; action?: string }>(request);
  const decision = p?.decision === 'Approved' ? 'Approved' : p?.decision === 'Rejected' ? 'Rejected' : null;
  if (!decision) return fail('Choose Approve or Reject.');
  const row = await env.DB.prepare('SELECT * FROM approvals WHERE id=?').bind(id).first<Record<string, unknown>>();
  const user = actor(request);
  if (!row || (!isAdmin(user) && !(typeof row.run_id === 'string' && await canReadRun(env, user, row.run_id)))) return fail('Approval not found.', 404);
  if (p?.action !== row.action) return fail('Review the exact current action before deciding.', 409);
  if (row.receipt || (typeof row.expires_at === 'string' && Date.parse(row.expires_at) <= Date.now())) return fail('This command approval has expired or already settled.', 409);
  if (row.status !== 'Pending' && row.status !== decision) return fail('This approval already has a decision.', 409);
  await env.DB.prepare("UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='Pending'").bind(decision, user.id, now(), id).run();
  const approval = mapApproval((await env.DB.prepare('SELECT * FROM approvals WHERE id=?').bind(id).first<Record<string, unknown>>())!);
  await emit(env, 'approval.updated', { approval });
  return ok({ approval });
}
