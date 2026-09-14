import { env } from '@/lib/server/env';
import { ok } from '@/lib/buzz/db';
import { actor } from '@/lib/server/team';
import { visibleEvents } from '@/lib/server/access';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  const after=Number(new URL(request.url).searchParams.get('after'))||0;
  return ok(await visibleEvents(env,actor(request),after));
}
