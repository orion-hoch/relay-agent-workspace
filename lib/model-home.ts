export type HomeKind = 'local' | 'cloud';
export function agentHome(agent: {homeId?: unknown; runtime?: unknown}): HomeKind {
  if (['openai-preview', 'cloud-preview'].includes(String(agent.homeId))) return 'cloud';
  if (agent.homeId === 'lab' || agent.homeId === 'studio' || String(agent.homeId).startsWith('local:')) return 'local';
  return agent.runtime === 'cloud' ? 'cloud' : 'local';
}
export function agentHomeId(agent: {homeId?: unknown; runtime?: unknown}) {
  if (agentHome(agent) === 'cloud') return 'openai-preview';
  return typeof agent.homeId === 'string' && agent.homeId.startsWith('local:') ? agent.homeId : 'lab';
}
export function modelHomeId(model: {provider?: string; homeId?: string}) {
  return model.provider ? 'openai-preview' : model.homeId || 'lab';
}
export function modelFitsHome(model: {provider?: string; homeId?: string}, home: string) {
  if (home === 'cloud' || home === 'local') return (model.provider ? 'cloud' : 'local') === home;
  return modelHomeId(model) === home;
}
export function localHomeId(address: string) {
  const host = new URL(address).hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ? 'lab' : `local:${host}`;
}
