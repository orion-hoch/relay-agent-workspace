import type {BuzzEnv} from '../buzz/db';
import type {MemberRecord} from '../buzz/types';
import {repositoryInfo,repositoryPaths} from './git';
import {resolveTaskWorkspace} from './task-workspace';

export async function agentWorkspace(env:BuzzEnv,agent:MemberRecord,taskId?:string) {
  const setting=await env.DB.prepare("SELECT value FROM settings WHERE key='team_config'").first<{value:string}>();
  const network=agent.data.networkAccess===true && !!setting && ['connected','custom'].includes(JSON.parse(setting.value).networkMode);
  if(!taskId)return {network};
  const task=await env.DB.prepare('SELECT id,owner,agent_id,room FROM tasks WHERE id=?').bind(taskId).first<{id:string;owner:string;agent_id:string;room:string}>();
  if(!task)throw new Error('The task workspace no longer exists.');
  if(await repositoryInfo(taskId)) {
    const paths=await repositoryPaths({...task,agentId:task.agent_id});
    return {network,directory:paths.work,gitDirectory:paths.git};
  }
  return {network,directory:await resolveTaskWorkspace(taskId)};
}
