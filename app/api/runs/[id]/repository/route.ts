import {env} from '@/lib/server/env';
import {body,fail,now,ok} from '@/lib/buzz/db';
import {getAgent} from '@/lib/buzz/context';
import {canUseContextRoom,resolveContextRoom} from '@/lib/buzz/context-scope';
import {canReadRoom,canUseAgent} from '@/lib/server/access';
import {userById} from '@/lib/server/team';
import {prepareRepository,repositoryInfo} from '@/lib/server/git';
import {agentWorkspace} from '@/lib/server/agent-workspace';
export const dynamic='force-dynamic';

// The runner can check out only the repository for the task it currently owns.
// Credentials remain in the existing human Git setup; this tool never accepts them.
export async function POST(request:Request,ctx:{params:Promise<{id:string}>}) {
  if(request.headers.get('x-shoal-device')!=='local')return fail('Runner token required.',401);
  const {id}=await ctx.params,input=await body<{runnerId?:string;attempt?:number;url?:string;baseBranch?:string}>(request);
  const run=await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<{agent_id:string;task_id:string;room:string;requested_by:string;runner_id:string;attempt:number;status:string;backend:string;lease_until:string}>();
  if(!input || !run || run.runner_id!==input.runnerId || run.attempt!==input.attempt || run.status!=='running' || run.backend!=='vllm' || !run.lease_until || run.lease_until<now())return fail('This run is no longer active on the runner.',409);
  if(typeof input.url!=='string' || (input.baseBranch!==undefined && typeof input.baseBranch!=='string'))return fail('Provide an HTTPS repository URL and optional base branch.');
  const user=await userById(run.requested_by),agent=await getAgent(env,run.agent_id);
  const task=run.task_id ? await env.DB.prepare('SELECT id,owner,agent_id,room FROM tasks WHERE id=?').bind(run.task_id).first<{id:string;owner:string;agent_id:string;room:string}>() : null;
  if(!user?.active || user.role==='viewer' || !agent || !task || task.owner!==user.id || task.agent_id!==agent.id || !canUseAgent(user,agent) || !await canReadRoom(env,user,run.room) || !await canUseContextRoom(env,agent,await resolveContextRoom(env,run.room)))return fail('The requester or agent cannot access this task.',403);
  try {
    let repository=await repositoryInfo(task.id);
    if(repository) {
      if(repository.url.replace(/(?:\.git)?\/$|\.git$/,'')!==input.url.replace(/(?:\.git)?\/$|\.git$/,''))return fail('This task already has a repository. Use its existing checkout or start another task.',409);
    } else {
      const prepared=await prepareRepository({...task,agentId:task.agent_id},input.url,'',input.baseBranch || '',request.signal);
      repository=prepared.repository;
      await env.DB.prepare("INSERT INTO connections(id,kind,name,config,secret,created_at) VALUES (?,'git',?,?,?,?)").bind('git:'+task.id,repository.url,JSON.stringify(repository),prepared.secret,now()).run();
      await env.DB.prepare("INSERT INTO run_events(run_id,type,payload,ts) VALUES (?,'repository.ready',?,?)").bind(id,JSON.stringify({url:repository.url,branch:repository.branch}),now()).run();
    }
    return ok({repository,workspace:await agentWorkspace(env,agent,task.id)});
  } catch(error) {return fail(error instanceof Error?error.message:'Could not check out the repository.',400);}
}
