import {prepareRepository,repositoryInfo} from '@/lib/server/git';
import {env} from '@/lib/server/env';
import {actor,isAdmin} from '@/lib/server/team';
import {canonicalRoom,canUseAgent,publicRun} from '@/lib/server/access';
import {getAgent} from '@/lib/buzz/context';
import {canUseContextRoom,dmMembers,resolveContextRoom} from '@/lib/buzz/context-scope';
import {selectedModel} from '@/lib/buzz/models';
import {body,emit,fail,id,mapMessage,mapRun,now,ok} from '@/lib/buzz/db';
import type {AgentTask} from '@/lib/task-types';
import {mkdir,readdir} from 'node:fs/promises';
import {resolveTaskWorkspace,taskWorkspaceName} from '@/lib/server/task-workspace';
export const dynamic='force-dynamic';
type Row=Record<string,unknown>;
async function tasks(userId:string,room?:string):Promise<AgentTask[]> {
  const rows=await env.DB.prepare(`SELECT t.* FROM tasks t LEFT JOIN messages m ON m.id=substr(t.room,8) WHERE t.owner=? AND t.agent_id IS NOT NULL ${room?'AND (t.room=? OR m.room=?)':''} ORDER BY t.created_at DESC LIMIT 100`).bind(userId,...(room?[room,room]:[])).all<Row>();
  return Promise.all(rows.results.map(async row=>{
    const run=await env.DB.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(row.id).first<Row>();
    return {id:String(row.id),goal:String(row.description),context:String(row.context),agentId:String(row.agent_id),room:String(row.room),status:row.status==='done'?'done':'open',createdAt:String(row.created_at),workspaceDirectory:typeof row.workspace_directory==='string'?row.workspace_directory:undefined,repository:await repositoryInfo(String(row.id)),run:run?publicRun(mapRun(run),userId):null};
  }));
}
export async function GET(request:Request){
  const user=actor(request),room=await canonicalRoom(env,user,new URL(request.url).searchParams.get('room') || '',false);
  if(!room)return fail('Choose a conversation.',404);
  return ok({tasks:await tasks(user.id,room)});
}
export async function POST(request:Request){
  const user=actor(request);
  if(user.role==='viewer')return fail('Viewers cannot start agent tasks.',403);
  const input=await body<{action?:string;id?:string;agentId?:string;goal?:string;context?:string;instruction?:string;room?:string;workspaceDirectory?:string;repositoryUrl?:string;repositoryToken?:string;baseBranch?:string}>(request);
  if(!input)return fail('Enter a goal and choose an agent.');
  const existing=input.id ? (await tasks(user.id)).find(task=>task.id===input.id) : undefined;
  if(input.id && !existing)return fail('Task not found.',404);
  const active=existing?.run && ['queued','preparing','running','awaiting'].includes(existing.run.status);
  if(input.action==='complete'){
    if(!existing)return fail('Task not found.',404);
    if(active)return fail('Stop or finish the active run before marking the goal done.',409);
    await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=? AND owner=?").bind(existing.id,user.id).run();
    return ok({tasks:await tasks(user.id)});
  }
  if(input.action && !['create','continue'].includes(input.action))return fail('Unknown task action.');
  if(input.action==='continue' && !existing)return fail('Task not found.',404);
  if(active)return fail('This task is already running.',409);
  const goal=existing?.goal || (typeof input.goal==='string'?input.goal.trim():'');
  const context=existing?.context ?? (typeof input.context==='string'?input.context.trim():'');
  const instruction=typeof input.instruction==='string'?input.instruction.trim():'';
  if(!goal || goal.length>4000 || context.length>12000 || instruction.length>4000)return fail('Use a goal under 4,000 characters and context under 12,000.');
  const agent=await getAgent(env,existing?.agentId || input.agentId || '');
  if(!agent || !canUseAgent(user,agent))return fail('Choose an available agent.',403);
  const requestedRoom=existing?.room || (typeof input.room==='string'?input.room:`dm:${agent.id}`);
  const origin=await canonicalRoom(env,user,requestedRoom);
  const scope=origin && await resolveContextRoom(env,origin).catch(()=>null);
  if(!origin || !scope || (scope.startsWith('dm:') && !dmMembers(scope).includes(agent.id)) || !await canUseContextRoom(env,agent,scope))return fail('This agent cannot access the conversation.',403);
  if(!existing && origin.startsWith('thread:') && (await tasks(user.id)).some(task=>task.room===origin))return fail('Reply in this thread to continue its task.',409);
  let inference;
  try{inference=await selectedModel(env,agent.id,user.id);}catch(error){return fail(error instanceof Error?error.message:'Connect a model for this agent.',409);}
  let workspaceDirectory:string|undefined;
  try{workspaceDirectory=existing?existing.workspaceDirectory:taskWorkspaceName(input.workspaceDirectory);}catch(error){return fail((error as Error).message);}
  if((existing?.repository || input.repositoryUrl || workspaceDirectory) && inference.execution!=='vllm')return fail('Choose a direct model agent for repository and working-directory tasks.',400);
  if(inference.execution==='openclaw' && !isAdmin(user))return fail('Native tool runtimes require an admin.',403);
  const taskId=existing?.id || id('task'),rootId=existing?.room.slice(7) || (origin.startsWith('thread:')?origin.slice(7):id('msg')),room=`thread:${rootId}`,stamp=now();
  const newRoot=!existing && !origin.startsWith('thread:');
  const triggerId=id('msg'),replyId=id('msg'),runId=id('run');
  const gitTask={id:taskId,owner:user.id,agentId:agent.id,room,workspaceDirectory};
  if(!existing){
    try{
      const directory=await resolveTaskWorkspace({workspaceDirectory});
      if(directory && !isAdmin(user) && (await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).length)return fail('An admin must assign an existing project folder to an agent. Choose a new or empty directory.',403);
      // The database batch serializes this overlap check with other task creations.
      const [created]=await env.DB.batch([env.DB.prepare("INSERT INTO tasks(id,project,title,description,status,owner,priority,due,label,created_at,agent_id,room,context,workspace_directory) SELECT ?,'',?,?,'open',?,'Medium','','',?,?,?,?,? WHERE ? = 1 OR NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_directory IS NOT NULL AND (lower(workspace_directory)=lower(?) OR substr(lower(workspace_directory),1,length(?)+1)=lower(?) || '/' OR substr(lower(?),1,length(workspace_directory)+1)=lower(workspace_directory) || '/'))").bind(taskId,goal.split('\n')[0].slice(0,100),goal,user.id,stamp,agent.id,room,context,workspaceDirectory ?? null,workspaceDirectory?0:1,workspaceDirectory ?? null,workspaceDirectory ?? null,workspaceDirectory ?? null,workspaceDirectory ?? null)]);
      if(!created.meta.changes)return fail('This directory overlaps another task’s workspace. Choose a different folder or continue that task.',409);
    }catch(error){return fail(error instanceof Error?error.message:'Could not reserve the task working directory.',400);}
  }
  let prepared;
  try{
    if(!existing && input.repositoryUrl)prepared=await prepareRepository(gitTask,input.repositoryUrl,input.repositoryToken,input.baseBranch,request.signal);
    else {const directory=await resolveTaskWorkspace({workspaceDirectory});if(directory)await mkdir(directory,{recursive:true,mode:0o700});}
  }catch(error){if(!existing)await env.DB.prepare('DELETE FROM tasks WHERE id=?').bind(taskId).run();return fail(error instanceof Error?error.message:'Could not prepare the task working directory.',400);}
  const text=`Goal: ${goal}${context?`\n\nGiven context:\n${context}`:''}${instruction?`\n\nNext instruction:\n${instruction}`:''}`;
  const statements=[];
  if(prepared)statements.push(env.DB.prepare("INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,'git',?,?,?,?)").bind('git:'+taskId,goal.slice(0,80),JSON.stringify(prepared.repository),prepared.secret,stamp));
  if(existing)statements.push(env.DB.prepare("UPDATE tasks SET status='open' WHERE id=? AND owner=?").bind(taskId,user.id));
  if(newRoot)statements.push(env.DB.prepare('INSERT INTO messages(id,room,member_id,name,body,created_at) VALUES (?,?,?,?,?,?)').bind(rootId,origin,user.id,user.name || user.username || 'You',goal,stamp));
  statements.push(
    env.DB.prepare('INSERT INTO messages(id,room,member_id,name,body,created_at) VALUES (?,?,?,?,?,?)').bind(triggerId,room,user.id,user.name || user.username || 'You',text,stamp),
    env.DB.prepare("INSERT INTO messages(id,room,member_id,name,body,created_at,run_id,state) VALUES (?,?,?,?,'',?,?,'pending')").bind(replyId,room,agent.id,agent.name,new Date(Date.parse(stamp)+1).toISOString(),runId),
    env.DB.prepare("INSERT INTO runs(id,kind,task_id,agent_id,room,message_id,trigger_message_id,parent_run_id,status,backend,mode,model,connection_id,created_at,requested_by) VALUES (?,'chat',?,?,?,?,?,?,'queued',?,'deep',?,?,?,?)").bind(runId,taskId,agent.id,room,replyId,triggerId,existing?.run?.id || null,inference.execution,inference.model,inference.id,stamp,user.id),
  );
  try{await env.DB.batch(statements);}catch{if(!existing)await env.DB.prepare('DELETE FROM tasks WHERE id=?').bind(taskId).run();return fail('Could not start the task. Check whether it is already running.',409);}
  for(const messageId of [newRoot?rootId:null,triggerId,replyId].filter(Boolean)){
    const row=await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(messageId).first<Row>();
    await emit(env,'message.created',{message:mapMessage(row!)});
  }
  const run=await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>();
  await emit(env,'run.queued',{run:mapRun(run!)});
  return ok({task:(await tasks(user.id)).find(task=>task.id===taskId)},202);
}
