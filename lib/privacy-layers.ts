import type { BuzzEnv } from './buzz/db';
import { LEVELS, type Level } from './buzz/types';

export type PrivacyLayer = { name: string; clearance: Level; localOnly: boolean };
export const DEFAULT_LAYERS: PrivacyLayer[] = LEVELS.map(name => ({ name, clearance: name, localOnly: name === 'Confidential' || name === 'Restricted' }));
export function privacyLayer(name: string, layers: PrivacyLayer[] = DEFAULT_LAYERS): PrivacyLayer {
  // Unknown classifications stay closed in the UI; server writes reject them.
  return layers.find(layer => layer.name === name) ?? { name, clearance: 'Restricted', localOnly: true };
}
export function layerAllowsAgent(layer: PrivacyLayer, clearance: Level, runtime: string): boolean {
  return LEVELS.indexOf(clearance) >= LEVELS.indexOf(layer.clearance) && (!layer.localOnly || runtime !== 'cloud');
}

export async function loadPrivacyLayers(env: BuzzEnv): Promise<PrivacyLayer[]> {
  const rows = await env.DB.prepare("SELECT value FROM settings WHERE key LIKE 'privacy-layer:%' ORDER BY key").all<{ value: string }>();
  return [...DEFAULT_LAYERS, ...rows.results.map(row => JSON.parse(row.value) as PrivacyLayer)];
}
