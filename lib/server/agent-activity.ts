import type { BuzzEnv } from '../buzz/db';
import type { TeamUser } from '../team-types';
import { readableRooms, publicRoom } from './access';

export type AgentActivityRecord = {
  id:string; agentId:string; agentName:string; room:string; status:string; model:string;
  request:string; response:string; error:string|null; createdAt:string; startedAt:string|null; endedAt:string|null;
  inputTokens:number|null; outputTokens:number|null;
};
export type AgentActivityPage = { records:AgentActivityRecord[]; next:string|null };
export async function readAgentActivity(env:BuzzEnv,user:TeamUser,query='',before=''):Promise<AgentActivityPage> {
  const rooms=await readableRooms(env,user);
  if (!rooms.length) return {records:[],next:null};
  const scope=`r.room IN (${rooms.map(()=>'?').join(',')})`;
  const cursor=before ? await env.DB.prepare(`SELECT r.created_at,r.id FROM runs r WHERE r.id=? AND ${scope}`).bind(before,...rooms).first<{created_at:string;id:string}>() : null;
  if (before && !cursor) throw new Error('Activity page not found.');
  const search=query.trim().slice(0,200).toLowerCase();
  const pattern='%'+search.replace(/[!%_]/g,'!$&')+'%';
  const rows=await env.DB.prepare(`SELECT r.id,r.agent_id,r.room,r.status,r.model,r.error,r.created_at,r.started_at,r.ended_at,r.input_tokens,r.output_tokens,
    COALESCE(a.name,reply.name,r.agent_id) AS agent_name,COALESCE(prompt.body,'') AS request,COALESCE(reply.body,'') AS response
    FROM runs r LEFT JOIN members a ON a.id=r.agent_id LEFT JOIN messages prompt ON prompt.id=r.trigger_message_id LEFT JOIN messages reply ON reply.id=r.message_id
    WHERE r.kind='chat' AND ${scope}
    ${search ? "AND (lower(COALESCE(a.name,reply.name,r.agent_id)) LIKE ? ESCAPE '!' OR lower(COALESCE(prompt.body,'')) LIKE ? ESCAPE '!' OR lower(COALESCE(reply.body,'')) LIKE ? ESCAPE '!')" : ''}
    ${cursor ? 'AND (r.created_at<? OR (r.created_at=? AND r.id<?))' : ''}
    ORDER BY r.created_at DESC,r.id DESC LIMIT 51`).bind(...rooms,...(search?[pattern,pattern,pattern]:[]),...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[])).all<{id:string;agent_id:string;agent_name:string;room:string;status:string;model:string|null;error:string|null;request:string;response:string;created_at:string;started_at:string|null;ended_at:string|null;input_tokens:number|null;output_tokens:number|null}>();
  const records=rows.results.slice(0,50).map(row=>({
    id:String(row.id),agentId:String(row.agent_id),agentName:String(row.agent_name),room:publicRoom(String(row.room),user.id),
    status:String(row.status),model:String(row.model||''),request:String(row.request),response:String(row.response),error:row.error===null?null:String(row.error),
    createdAt:String(row.created_at),startedAt:row.started_at===null?null:String(row.started_at),endedAt:row.ended_at===null?null:String(row.ended_at),
    inputTokens:row.input_tokens===null?null:Number(row.input_tokens),outputTokens:row.output_tokens===null?null:Number(row.output_tokens),
  }));
  return {records,next:rows.results.length>50?records.at(-1)!.id:null};
}
