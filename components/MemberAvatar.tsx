'use client';
import { avatarColor } from '@/lib/avatar';
import { AgentAvatar } from './AgentAvatar';
import type { WorkspaceMember } from '@/lib/workspace-members';

export function MemberAvatar({ member, name, initials, size = 32 }: { member?: WorkspaceMember; name?: string; initials?: string; size?: number }) {
  if (member?.kind === 'agent') return <AgentAvatar identityKey={member.id} avatar={member.avatar} character={member.character} label={member.name} size={size} />;
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Initials are a text fallback avatar, not an external image.
  return <span className="member-avatar" style={{ ...avatarColor(member?.id ?? name ?? 'you'), width: size, height: size, fontSize: Math.max(10, Math.round(size * .32)) }} role="img" aria-label={member?.name ?? name ?? 'Member'}>{member?.initials ?? initials ?? '?'}</span>;
}
