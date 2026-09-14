import {createHash} from 'node:crypto';
import {env} from '@/lib/server/env';
import {body,fail,id,now,ok} from '@/lib/buzz/db';
import {buildPacket,getAgent} from '@/lib/buzz/context';
import {selectedModel} from '@/lib/buzz/models';
import {userById} from '@/lib/server/team';
import {canReadRoom,canUseAgent} from '@/lib/server/access';
import {checkSharedSources,collaborators} from '@/lib/server/collaboration';
import {agentWorkspace} from '@/lib/server/agent-workspace';
export const dynamic='force-dynamic';
export async function POST(request:Request,ctx:{params:Promise<{id:string}>}) {
  if(request.headers.get('x-shoal-device')!=='local')return fail('Runner token required.',401);
  const {id:parentId}=await ctx.params,input=await body<{runnerId?:string;attempt?:number;agent?:string;task?:string}>(request);
  const parent=await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(parentId).first<{agent_id:string;room:string;task_id?:string;status:string;kind:string;requested_by:string;runner_id:string;attempt:number;lease_until:string;mode:'quick'|'deep'}>();
  if(!parent || !input || parent.runner_id!==input.runnerId || parent.attempt!==input.attempt || parent.status!=='running' || parent.kind!=='chat' || parent.lease_until<now())return fail('The parent run is no longer active on this runner.',409);
  if(typeof input.agent!=='string' || typeof input.task!=='string' || !input.task.trim() || input.task.length>4000)return fail('Choose an agent and give it an assignment under 4,000 characters.');
  const user=await userById(parent.requested_by),parentAgent=await getAgent(env,parent.agent_id);
  if(!user?.active || user.role==='viewer' || !parentAgent || !canUseAgent(user,parentAgent) || !await canReadRoom(env,user,parent.room))return fail('This task is no longer available to its requester.',403);
  const target=(await collaborators(env,user,parent.agent_id,parent.room)).find(agent=>agent.id===input.agent || agent.name.toLowerCase()===input.agent!.toLowerCase());
  if(!target)return fail('That agent is unavailable or cannot access this conversation.',403);
  try {
    await checkSharedSources(env,user,parent.agent_id,parent.room,target);
    const model=await selectedModel(env,target.id,user.id),budget=Math.min(20480,model.contextWindow);
    if(budget<2048)return fail('This agent’s model needs a larger context window.',409);
    const childId=id('collab'),stamp=now();
    const parentWorkspace=await agentWorkspace(env,parentAgent,parent.task_id),workspace={...parentWorkspace,network:parentWorkspace.network && target.data.networkAccess===true};
    const packet=await buildPacket({...env,BUZZ_VLLM_URL:model.url,BUZZ_MODEL:model.model,BUZZ_VLLM_TOKEN:model.token},{agent:target,objective:input.task.trim(),room:parent.room,taskOnly:true,toolsEnabled:true,delegated:true,workspace,taskContract:`You are collaborating with ${parentAgent.name}. The task files are shared at /workspace. Inspect the existing files, carry out only your assignment, and report your actual changes and test results. Preserve other work. You can search for more context within the data grants shared by you and ${parentAgent.name}. Do not delegate further.`,mode:parent.mode,runId:childId,budgetTokens:budget,outputReserve:Math.min(4096,Math.floor(budget/3)),sessionKey:childId,backend:'vllm',model:model.model,inferenceModel:model.model});
    packet.inferenceModel=model.model;
    const child={nativeRunId:childId,agentId:target.id,agentName:target.name,backend:'vllm',model:model.model,status:'running',acceptedAt:stamp,startedAt:stamp};
    const saved=await env.DB.prepare("INSERT INTO run_events(run_id,type,payload,ts) SELECT ?,'collaboration.granted',?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status='running' AND runner_id=? AND attempt=? AND lease_until>?) AND (SELECT count(*) FROM run_events WHERE run_id=? AND type='collaboration.granted')<3").bind(parentId,JSON.stringify(child),stamp,parentId,input.runnerId,input.attempt,now(),parentId).run();
    if(!saved.meta.changes)return fail('This run has ended or reached its collaboration limit.',409);
    const sandboxScope=createHash('sha256').update(JSON.stringify([user.id,parent.agent_id,parent.room])).digest('hex');
    return ok({child,packet,execution:{baseUrl:model.url,token:model.token || '',provider:model.provider,agentId:target.id,sandboxScope,workspace,delegated:true}});
  }catch(error){return fail(error instanceof Error?error.message:'Could not contact that agent.',403);}
}
