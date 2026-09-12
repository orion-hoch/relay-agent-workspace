import { env } from 'cloudflare:workers';
import { computeSetup, type ComputeSetupConfig } from '@/lib/compute-setup';
import { type BuzzEnv, sameOrigin, fail } from '@/lib/buzz/db';
import { GET as runtime } from '@/app/api/runtime/route';
import type { ComputeHomeMetrics } from '@/lib/buzz/telemetry';
export const dynamic = 'force-dynamic';
async function status(request: Request) {
  if (!sameOrigin(request)) return fail('Open setup from your workspace.', 403);
  const config = env as unknown as BuzzEnv & ComputeSetupConfig;
  if (!config.BUZZ_OPENCLAW_URL) return computeSetup(request, config);
  const response = await runtime();
  const data = await response.json() as { metrics: ComputeHomeMetrics | null; homes: { connected: boolean; model: string }[] };
  const home = data.homes[0];
  return Response.json({ metrics: data.metrics, phase: home?.connected ? 'ready' : 'error', model: home?.model || config.BUZZ_MODEL || '', ...(home?.connected ? {} : { error: 'The configured local runtime is not reachable.' }) }, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = status;
export const POST = status;
