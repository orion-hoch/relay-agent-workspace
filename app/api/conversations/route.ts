import {env} from '@/lib/server/env';
import {actor} from '@/lib/server/team';
import {canonicalRoom,publicRoom} from '@/lib/server/access';
import {body,emit,fail,now,ok} from '@/lib/buzz/db';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  const user=actor(request),input=await body<{room?:string;hidden?:boolean}>(request);
  if(typeof input?.room!=='string'||typeof input.hidden!=='boolean')return fail('Choose a conversation action.');
  const room=await canonicalRoom(env,user,input.room,false);
  if(!room||room.startsWith('thread:'))return fail('Conversation not found.',404);
  if(input.hidden)await env.DB.prepare('INSERT INTO conversation_preferences(user_id,room,hidden_at) VALUES (?,?,?) ON CONFLICT(user_id,room) DO UPDATE SET hidden_at=excluded.hidden_at').bind(user.id,room,now()).run();
  else await env.DB.prepare('DELETE FROM conversation_preferences WHERE user_id=? AND room=?').bind(user.id,room).run();
  await emit(env,'conversation.preference',{userId:user.id,room,hidden:input.hidden});
  return ok({room:publicRoom(room,user.id),hidden:input.hidden});
}
