import { actor,isAdmin } from '@/lib/server/team';
import { env } from '@/lib/server/env';
import { body, emit, fail, mapMember, now, ok } from '@/lib/buzz/db';
import { loadPrivacyLayers } from '@/lib/privacy-layers';
import { agentLevel } from '@/lib/buzz/context-scope';
import { layerAllowsAgent, privacyLayer } from '@/lib/privacy-layers';
import { agentHome } from '@/lib/model-home';
export const dynamic = 'force-dynamic';
async function save(request: Request, editing: boolean) {
  if(!isAdmin(actor(request)))return fail('Only admins can change channels.',403);
  const data = await body<{action?:string;newName?:string;name?:string;level?:string;agents?:string[];topic?:string;description?:string}>(request);
  const name = typeof data?.name === 'string' ? data.name.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(name)) return fail('Use 1–60 letters, numbers, hyphens or underscores.');
  const existing = await env.DB.prepare('SELECT name,display_name FROM channels WHERE name=?').bind(name).first<{name:string;display_name:string|null}>();
  if (editing && !existing) return fail('Channel not found.',404);
  if (!editing && existing) return fail('A channel with this name already exists.',409);
  if(editing && data?.action==='rename'){
    const displayName=typeof data.newName==='string'?data.newName.trim().toLowerCase():'';
    if(!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(displayName))return fail('Use 1–60 letters, numbers, hyphens or underscores.');
    if(await env.DB.prepare('SELECT name FROM channels WHERE COALESCE(display_name,name)=? AND name<>?').bind(displayName,name).first())return fail('A channel with this name already exists.',409);
    // The internal room key stays stable, preserving history, files, model choices and in-flight runs.
    try{await env.DB.prepare('UPDATE channels SET display_name=? WHERE name=?').bind(displayName,name).run();}
    catch(error){if(/unique|duplicate/i.test(String(error)))return fail('A channel with this name already exists.',409);throw error;}
    await emit(env,'workspace.updated',{key:'channels'});
    return ok({name,displayName});
  }
  if(!editing && await env.DB.prepare('SELECT name FROM channels WHERE COALESCE(display_name,name)=?').bind(name).first())return fail('A channel with this name already exists.',409);
  const level = data?.level || 'Internal';
  const layers=await loadPrivacyLayers(env);
  if (!layers.some(layer=>layer.name===level)) return fail('Choose a classification.');
  if (!Array.isArray(data?.agents) || data.agents.length>100 || data.agents.some(id=>typeof id!=='string')) return fail('Choose the agents for this channel.');
  for(const key of ['topic','description'] as const) if(data?.[key]!==undefined && (typeof data[key]!=='string' || data[key]!.length>(key==='topic'?250:2000))) return fail('Topic or description is too long.');
  const topic=data?.topic?.trim() || '',description=data?.description?.trim() || '';
  const agents = [...new Set(data.agents)];
  const rows = await env.DB.prepare("SELECT * FROM members WHERE kind='agent'").all<Record<string,unknown>>();
  const members = rows.results.map(mapMember);
  for (const id of agents) {
    const agent = members.find(agent=>agent.id===id);
    if (!agent || !layerAllowsAgent(privacyLayer(level,layers),agentLevel(agent,layers),agentHome(agent.data))) return fail('A selected agent cannot access this classification.');
  }
  if (editing) await env.DB.prepare('UPDATE channels SET level=?,agents=?,topic=?,description=? WHERE name=?').bind(level,JSON.stringify(agents),topic,description,name).run();
  else await env.DB.prepare('INSERT INTO channels(name,created_at,level,agents,topic,description) VALUES (?,?,?,?,?,?)').bind(name,now(),level,JSON.stringify(agents),topic,description).run();
  const channel = {name,displayName:existing?.display_name || name,level,agents,topic,description};
  await emit(env,editing?'channel.updated':'channel.created',{name,channel});
  return ok({name,channel});
}
export const POST = (request:Request) => save(request,false);
export const PATCH = (request:Request) => save(request,true);
