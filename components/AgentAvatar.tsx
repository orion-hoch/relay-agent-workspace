'use client';

import Image from 'next/image';
import { avatarColor, agentInitials } from '@/lib/avatar';
import { useSyncExternalStore } from 'react';

import { type AgentCharacter } from '@/lib/agent-characters';
export type AgentState = 'idle' | 'sleep' | 'thinking' | 'stuck';
export type AgentActivity = 'ready' | 'working' | 'blocked' | 'offline' | 'sleeping' | 'paused';

type Identity = { avatar?: string; character?: AgentCharacter; state?: AgentState; available?: boolean; paused?: boolean };
function effectiveState(identity?: Identity): AgentState { return identity?.paused ? 'sleep' : identity?.state ?? (identity?.available === false ? 'sleep' : 'idle'); }
const identities = new Map<string, Identity>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function updateIdentity(name: string, changes: Identity) {
  const previous = identities.get(name);
  const next = { ...previous, ...changes };
  if (previous?.character === next.character && previous?.state === next.state && previous?.available === next.available && previous?.paused === next.paused && previous?.avatar === next.avatar) return;
  identities.set(name, next);
  for (const notify of listeners) notify();
}

/** Called by the runtime adapter when an agent's activity changes. */
export function setAgentAvailability(id: string, available: boolean, paused: boolean, character: AgentCharacter, avatar?: string) { updateIdentity(id, { available, paused, character, avatar }); }

export function setAgentActivity(name: string, activity: AgentActivity) {
  const states: Record<AgentActivity, AgentState> = {
    ready: 'idle', working: 'thinking', blocked: 'stuck',
    offline: 'sleep', sleeping: 'sleep', paused: 'sleep',
  };
  updateIdentity(name, { state: activity === 'ready' ? undefined : states[activity] });
}

export function useAgentState(name: string): AgentState {
  return useSyncExternalStore(subscribe, () => effectiveState(identities.get(name)), () => 'idle');
}

/** Custom pictures or stable colored initials, shared across the workspace. */
export function AgentAvatar({
  avatar, character = 'octopus', state = 'idle', size = 32, label, identityKey, className = '', preview = false,
}: {
  avatar?: string; character?: AgentCharacter; state?: AgentState; size?: number; label?: string;
  identityKey?: string; className?: string; preview?: boolean;
}) {
  const identity = useSyncExternalStore(
    subscribe,
    () => !preview && (identityKey || label) ? identities.get(identityKey || label!) : undefined,
    () => undefined,
  );
  avatar = avatar ?? identity?.avatar;
  character = identity?.character ?? character;
  state = identity ? effectiveState(identity) : state;
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- An initials avatar exposes a single accessible identity.
    <span role="img" aria-label={label ?? 'Agent'}
      data-agent-id={identityKey} data-agent-character={character} data-agent-state={state}
      className={`agent-sprite ${avatar ? "agent-custom-avatar" : ""} ${className}`} style={{ ...avatarColor(label || identityKey || 'Agent'), width: size, height: size, fontSize: Math.max(10,Math.round(size*.34)), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight:600 }}>
      {avatar ? <Image src={avatar} alt="" width={size} height={size} unoptimized /> : <span aria-hidden="true">{agentInitials(label || '')}</span>}
    </span>
  );
}
