'use client';
import { useMemo } from 'react';
import { useBuzz } from './buzz/store';

export type AgentHome = { id: string; name: string; kind: 'local' | 'cloud'; status: 'empty' | 'offline' | 'connected'; modelCount:number };

/** Home readiness comes from the configured providers’ observed model lists. */
export function useAgentHomes(): readonly AgentHome[] {
  const { runtime } = useBuzz();
  return useMemo(() => {
    return runtime?.homes.map(home => ({id: home.id, name: home.name, kind: home.id === 'openai-preview' ? 'cloud' as const : 'local' as const, status: home.connected ? 'connected' as const : home.modelCount ? 'offline' as const : 'empty' as const, modelCount:home.modelCount})) ?? [];
  }, [runtime]);
}
