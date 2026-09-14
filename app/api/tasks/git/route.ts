import {env} from '@/lib/server/env';
import {actor} from '@/lib/server/team';
import {body,fail,now,ok} from '@/lib/buzz/db';
import {selectedModel} from '@/lib/buzz/models';
import {commitRepository,gitChanges,prepareRepository,pushRepository,repositoryInfo} from '@/lib/server/git';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  const user=actor(request),input=await body<{taskId?:string;action?:string;message?:string;repositoryUrl?:string;repositoryToken?:string;baseBranch?:string}>(request);
  const row=await env.DB.prepare('SELECT id,owner,agent_id,room,title FROM tasks WHERE id=? AND owner=?').bind(input?.taskId || '',user.id).first<{id:string;owner:string;agent_id:string;room:string;title:string}>();
  if(!row || !row.agent_id)return fail('Task not found.',404);
  if(user.role==='viewer')return fail('Viewers cannot change repositories.',403);
  const task={...row,agentId:row.agent_id};
  try{
    const repository=await repositoryInfo(row.id);
    if(input?.action==='connect'){
      if(repository)return fail('This task already has a connected repository.',409);
      if(await env.DB.prepare("SELECT id FROM runs WHERE task_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(row.id).first())return fail('Stop or finish the agent before connecting a repository.',409);
      if((await selectedModel(env,task.agentId,user.id)).execution!=='vllm')return fail('Choose a direct model agent for repository tasks.',400);
      const prepared=await prepareRepository(task,input.repositoryUrl || '',input.repositoryToken,input.baseBranch,request.signal);
      await env.DB.prepare("INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,'git',?,?,?,?)").bind('git:'+task.id,row.title.slice(0,80),JSON.stringify(prepared.repository),prepared.secret,now()).run();
      return ok(await gitChanges(task));
    }
    if(!repository)return fail('Repository not found.',404);
    if(input?.action==='diff')return ok(await gitChanges(task));
    if(await env.DB.prepare("SELECT id FROM runs WHERE task_id=? AND status IN ('queued','preparing','running','awaiting') LIMIT 1").bind(row.id).first())return fail('Stop or finish the agent before committing or pushing.',409);
    if(input?.action==='commit')return ok({output:await commitRepository(task,input.message || '',user.name || user.username || 'Shoal user'),...await gitChanges(task)});
    if(input?.action==='push')return ok({output:await pushRepository(task),...await gitChanges(task)});
    return fail('Choose a Git action.');
  }catch(error){return fail(error instanceof Error?error.message:'Git operation failed.',400);}
}
