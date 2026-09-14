import { loadPrivacyLayers, layerAllowsAgent } from '../privacy-layers';
import { agentLevel } from '../buzz/context-scope';
import { mapMember, type BuzzEnv } from '../buzz/db';

export async function validateSourcePolicy(env: BuzzEnv, name: string, grants: string[]) {
  const layers=await loadPrivacyLayers(env);
  const layer = layers.find(layer => layer.name === name);
  if (!layer) throw new Error('Choose an existing privacy layer.');
  if (!Array.isArray(grants) || grants.length > 100 || grants.some(id => typeof id !== 'string')) throw new Error('Choose current workspace agents.');
  if (grants.length === 1 && grants[0] === '*') return layer;
  const rows = await env.DB.prepare("SELECT * FROM members WHERE kind='agent'").all<Record<string, unknown>>();
  const agents = rows.results.map(mapMember);
  for (const id of grants) {
    const agent = agents.find(agent => agent.id === id);
    if (!agent || !layerAllowsAgent(layer, agentLevel(agent,layers), agent.data.runtime === 'cloud' ? 'cloud' : 'local')) throw new Error('An assigned agent does not meet this layer’s clearance or local-only rule. Update the agent selection.');
  }
  return layer;
}

export { loadPrivacyLayers } from '../privacy-layers';
