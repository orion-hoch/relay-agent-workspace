'use client';
import { useEffect, useState } from 'react';
import { useAgentState } from './AgentAvatar';
export function AgentThinkingBubble({ name, agentId }: { name: string; agentId: string }) {
  const state = useAgentState(agentId);
  const show = state === 'thinking';
  const [presence, setPresence] = useState<'shown' | 'hiding' | 'hidden'>(show ? 'shown' : 'hidden');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const frame = requestAnimationFrame(() => {
      if (show) setPresence('shown');
      else {
        setPresence(current => current === 'hidden' ? 'hidden' : 'hiding');
        timer = setTimeout(() => setPresence('hidden'), 220);
      }
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [show]);
  if (presence === 'hidden') return null;
  return <output className="agent-thinking-bubble" data-presence={presence}
    aria-label={`${name} is thinking`}>
    Thinking
  </output>;
}
