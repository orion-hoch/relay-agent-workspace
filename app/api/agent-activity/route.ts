import { env } from '@/lib/server/env';
import { actor, isAdmin } from '@/lib/server/team';
import { readAgentActivity } from '@/lib/server/agent-activity';
import { ok, fail } from '@/lib/buzz/db';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const user=actor(request);
  if(!isAdmin(user))return fail('Agent activity requires a workspace admin.',403);
  const params=new URL(request.url).searchParams;
  try{return ok(await readAgentActivity(env,user,params.get('q')||'',params.get('before')||''));}
  catch(error){if(error instanceof Error && error.message==='Activity page not found.')return fail(error.message,404);throw error;}
}
