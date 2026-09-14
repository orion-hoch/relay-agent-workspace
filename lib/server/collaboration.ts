import {mapDocument,mapMember,type BuzzEnv} from '../buzz/db';
import {agentLevel,canUseContextRoom,resolveContextRoom} from '../buzz/context-scope';
import {configuredModels} from '../buzz/models';
import {agentHome,agentHomeId,modelFitsHome} from '../model-home';
import {layerAllowsAgent,loadPrivacyLayers,privacyLayer} from '../privacy-layers';
import {canReadDocument,canUseAgent} from './access';
import type {MemberRecord,Packet} from '../buzz/types';
import type {TeamUser} from '../team-types';

export async function collaborators(env:BuzzEnv,user:TeamUser,parentId:string,room:string|null) {
  const scope=await resolveContextRoom(env,room),models=await configuredModels(env,user.id);
  const rows=await env.DB.prepare("SELECT * FROM members WHERE kind='agent'").all<Record<string,unknown>>();
  const available=[];
  for(const agent of rows.results.map(mapMember)) {
    if(agent.id===parentId || !canUseAgent(user,agent) || !await canUseContextRoom(env,agent,scope))continue;
    if(models.some(model=>model.id===agent.data.modelConnection && !model.ownerId && model.execution==='vllm' && modelFitsHome(model,agentHomeId(agent.data))))available.push(agent);
  }
  return available;
}
// The shared sandbox may contain output from earlier runs in the same task.
// Each agent receiving it must still be allowed to see every contributing source.
export async function checkSharedSources(env:BuzzEnv,user:TeamUser,parentId:string,room:string|null,target:MemberRecord) {
  const rows=await env.DB.prepare("SELECT packet FROM runs WHERE requested_by=? AND agent_id=? AND COALESCE(room,'')=? AND packet IS NOT NULL").bind(user.id,parentId,room || '').all<{packet:string}>();
  const ids=new Set(rows.results.flatMap(row=>(JSON.parse(row.packet) as Packet).evidence.map(source=>source.documentId)));
  const retrieved=await env.DB.prepare("SELECT e.payload FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.requested_by=? AND r.agent_id=? AND COALESCE(r.room,'')=? AND e.type='context.retrieved'").bind(user.id,parentId,room || '').all<{payload:string}>();
  for(const row of retrieved.results) for(const id of (JSON.parse(row.payload) as {documentIds:string[]}).documentIds) ids.add(id);
  const layers=await loadPrivacyLayers(env);
  for(const id of ids) {
    const row=await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(id).first<Record<string,unknown>>();
    const document=row?mapDocument(row):null;
    if(!document || !canReadDocument(user,document) || !layerAllowsAgent(privacyLayer(document.level,layers),agentLevel(target,layers),agentHome(target.data)) || !document.agents.some(id=>id==='*' || id===target.id))throw new Error(`${target.name} cannot access a source used in this task’s files. Start a new task or restore the required source permissions before reusing this workspace.`);
  }
}
