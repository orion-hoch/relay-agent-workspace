import { env } from '@/lib/server/env';
import { ok } from '@/lib/buzz/db';
import { actor, userById } from '@/lib/server/team';
import { visibleState } from '@/lib/server/access';
export const dynamic='force-dynamic';
export async function GET(request:Request) { return ok(await visibleState(env,(await userById(actor(request).id))!)); }
