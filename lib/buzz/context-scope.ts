import { agentHome } from '../model-home';
import { DEFAULT_LAYERS, loadPrivacyLayers, layerAllowsAgent, privacyLayer, type PrivacyLayer } from '../privacy-layers';
import { LEVELS, type Level, type MemberRecord, type ChannelRecord } from './types';
import type { BuzzEnv } from './db';

// A thread has the same audience as the conversation containing its root message.
export async function resolveContextRoom(env: BuzzEnv, room?: string | null): Promise<string | null> {
  let current = room ?? null;
  const seen = new Set<string>();
  while (current?.startsWith('thread:')) {
    if (seen.has(current) || seen.size >= 8) throw new Error('Invalid conversation thread.');
    seen.add(current);
    const parent = await env.DB.prepare('SELECT room FROM messages WHERE id = ?').bind(current.slice(7)).first<{ room: string }>();
    if (!parent) throw new Error('Conversation thread not found.');
    current = parent.room;
  }
  return current;
}

export async function roomLevel(env: BuzzEnv, room: string | null): Promise<Level | null> {
  if (!room || room.startsWith('dm:')) return null;
  const row = await env.DB.prepare('SELECT level FROM channels WHERE name=?').bind(room).first<{ level: Level }>();
  return row ? privacyLayer(row.level,await loadPrivacyLayers(env)).clearance : 'Internal';
}

export function agentLevel(agent: MemberRecord | null, layers:PrivacyLayer[]=DEFAULT_LAYERS): Level {
  const level = agent?.data.accessLevel as Level | undefined;
  return level ? layers.find(layer=>layer.name===level)?.clearance || 'Public' : 'Internal';
}

export const dmMembers = (room: string) => room.slice(3).split(':');

export function agentCanAccessChannel(agent:MemberRecord,channel:ChannelRecord,layers:PrivacyLayer[]=DEFAULT_LAYERS):boolean {
  const allowed = channel.agents === null ? !Array.isArray(agent.data.channels) || agent.data.channels.includes(channel.name) : channel.agents.includes(agent.id);
  return allowed && layerAllowsAgent(privacyLayer(channel.level,layers),agentLevel(agent,layers),agentHome(agent.data));
}
export async function canUseContextRoom(env: BuzzEnv, agent: MemberRecord, room: string | null): Promise<boolean> {
  if (!room || room.startsWith('dm:')) return true;
  const channel = await env.DB.prepare('SELECT level,agents FROM channels WHERE name=?').bind(room).first<{level:Level;agents:string|null}>();
  return !!channel && agentCanAccessChannel(agent,{name:room,level:channel.level,agents:channel.agents===null?null:JSON.parse(channel.agents)},await loadPrivacyLayers(env));
}

export function canReadHistoryMessage(agent: MemberRecord, room: string | null, memberId: string): boolean {
  if (!room?.startsWith('dm:')) return true;
  const members = dmMembers(room);
  return members.includes(agent.id) && members.includes(memberId);
}

// Initial packets and follow-up tool reads use the same conversation audience.
export async function contextAccess(env: BuzzEnv, agent: MemberRecord, room?: string | null) {
  const scopeRoom = await resolveContextRoom(env, room);
  if (!await canUseContextRoom(env, agent, scopeRoom)) throw new Error(`${agent.name} does not have access to this conversation.`);
  const ceiling = await roomLevel(env, scopeRoom);
  const clearance = agentLevel(agent, await loadPrivacyLayers(env));
  const level = ceiling ? LEVELS[Math.min(LEVELS.indexOf(clearance), LEVELS.indexOf(ceiling))] : clearance;
  const readers: string[] = [];
  for (const participant of scopeRoom?.startsWith('dm:') ? dmMembers(scopeRoom) : []) {
    if (await env.DB.prepare("SELECT id FROM members WHERE id=? AND kind='human'").bind(participant).first()) readers.push(participant);
  }
  return { room: scopeRoom, level, readers };
}
