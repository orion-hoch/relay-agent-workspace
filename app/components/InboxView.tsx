// List/detail hierarchy adapted from Buzz InboxListPane and InboxDetailPane.
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clockTime, escapeRegExp } from '@/lib/format';
import type { MessageRecord } from '@/lib/buzz/types';
import { useBuzz, type BuzzStore } from '@/lib/buzz/store';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCheck,
  Inbox,
  Mail,
  MailOpen,
  Search,
  X,
} from 'lucide-react';
import { MemberAvatar } from '@/components/MemberAvatar';
import { useWorkspaceMembers, type WorkspaceMember } from '@/lib/workspace-members';
import { PageHeader } from '@/components/buzz/PageHeader';
type Item = {
  id: string;
  sourceId: string;
  authorId: string;
  authorName: string;
  kind: 'review' | 'mention' | 'direct';
  readId?: string;
  readRoom?: string;
  notifiable?: boolean;
  unanswered?: boolean;
  channel: string;
  context: string;
  time: string;
  fullTime: string;
  createdAt: string;
  text: string;
  title: string;
  approvalId?: string;
  approvalStatus?: 'Pending' | 'Approved' | 'Rejected';
  threadId?: string;
};
function timeLabels(createdAt: string) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? { time: '', fullTime: '' }
    : { time: clockTime(createdAt), fullTime: date.toLocaleString() };
}

/** Shared records are the only source of inbox content; no local demonstration rows. */
export function buildInboxItems(
  state: Pick<BuzzStore, 'approvals' | 'messages' | 'runs' | 'user'>,
  members: readonly Pick<WorkspaceMember, 'id' | 'name' | 'kind'>[],
): Item[] {
  const { approvals, messages, runs, user } = state;
  if (!user) return [];
  const operator = members.find((member) => member.id === user?.id);
  const mentionNames = [user.name, user.username, operator?.name].filter((name): name is string => !!name);
  const mentionsOperator = new RegExp(`(^|[^\\w@])@(?:${mentionNames.map(escapeRegExp).join('|')})(?=$|[^\\w-])`, 'i');
  const byMessageId = new Map(messages.map((message) => [message.id, message]));
  function conversation(room: string) {
    const seen = new Set<string>();
    while (room.startsWith('thread:') && !seen.has(room)) {
      seen.add(room);
      const parent = byMessageId.get(room.slice(7));
      if (!parent) break;
      room = parent.room;
    }
    return room;
  }
  const peerId = (room: string) => room.slice(3).split(':').find(id => id !== user.id);
  const contextFor = (room: string) => {
    if (room.startsWith('dm:')) {
      const member = members.find((item) => item.id === peerId(room));
      return member ? `Direct message / ${member.name}` : 'Direct message';
    }
    return room ? `#${room}` : 'Conversation';
  };
  const latestDirect = new Map<string, MessageRecord>();
  for (const message of messages) {
    if (!conversation(message.room).startsWith('dm:')) continue;
    const previous = latestDirect.get(message.room);
    if (!previous || message.createdAt > previous.createdAt || (message.createdAt === previous.createdAt && message.id > previous.id)) latestDirect.set(message.room, message);
  }
  const direct = [...latestDirect.values()].flatMap((message): Item[] => {
    if(messages.some(reply=>reply.room===`thread:${message.id}` && reply.memberId!==message.memberId))return []; // The thread carries the reply state for this message.
    const room = conversation(message.room), peer = members.find(member => member.id === peerId(room));
    if (!peer) return [];
    const run = runs.find(run => run.id === message.runId);
    const outgoing = message.memberId === user.id;
    const cancelled = run?.status === 'cancelled';
    const failed = !cancelled && (message.state === 'error' || run?.status === 'failed');
    const waiting = !cancelled && !failed && (outgoing || message.state === 'pending' || !!run && ['queued','preparing','running','awaiting'].includes(run.status));
    const stage = cancelled ? 'cancelled' : failed ? 'failed' : waiting ? 'waiting' : peer.kind === 'human' ? 'message' : 'reply';
    const createdAt = run?.endedAt || message.createdAt;
    const threadId = message.room.startsWith('thread:') ? message.room.slice(7) : undefined;
    const request = run?.triggerMessageId ? byMessageId.get(run.triggerMessageId)?.body : undefined;
    return [{
      id: `direct:${message.room}`, sourceId: message.id, readId: `direct:${message.id}:${stage}`, readRoom: message.room,
      authorId: peer.id, authorName: peer.name, kind: 'direct', channel: room, threadId,
      context: `${contextFor(room)}${threadId ? ' / Thread' : ''}`,
      ...timeLabels(createdAt), createdAt,
      title: cancelled ? 'Reply cancelled' : failed ? 'Reply failed' : waiting ? run?.status === 'awaiting' ? 'Awaiting approval' : `Waiting for ${peer.name}` : peer.kind === 'human' ? 'Unanswered message' : 'Reply received',
      text: failed ? [request, message.error || run?.error || 'No reply received.'].filter(Boolean).join('\n\n') : waiting ? request || message.body || 'Awaiting reply.' : message.body || (cancelled ? 'The request was cancelled.' : 'File shared'),
      notifiable: !waiting, unanswered: !cancelled && (failed || (!outgoing && peer.kind === 'human') || (peer.kind === 'agent' && waiting)),
    }];
  });
  return [
    ...direct,
    ...approvals.map((approval): Item => {
      const author = members.find((member) => member.id === approval.agent || member.name === approval.agent);
      const room = runs.find((run) => run.id === approval.runId)?.room || '';
      return {
        id: `approval:${approval.id}`, sourceId: approval.id, approvalId: approval.id,
        authorId: author?.id || approval.agent, authorName: author?.name || approval.agent,
        kind: 'review', channel: room, unanswered: approval.status === 'Pending' && (!approval.expiresAt || Date.parse(approval.expiresAt) > Date.now()),
        context: `${room ? contextFor(room) : approval.workflow || 'Approvals'} / ${approval.status}`,
        ...timeLabels(approval.createdAt), createdAt: approval.createdAt,
        text: approval.body, title: approval.title, approvalStatus: approval.status,
      };
    }),
    ...messages.filter((message) => message.memberId !== user.id && !conversation(message.room).startsWith('dm:') && message.state !== 'pending' && message.state !== 'error' && mentionsOperator.test(message.body)).map((message): Item => {
      const room = conversation(message.room);
      const threadId = message.room.startsWith('thread:') ? message.room.slice(7) : undefined;
      const author = members.find((member) => member.id === message.memberId);
      const name = author?.name || message.name || message.memberId;
      return {
        id: `mention:${message.id}`, sourceId: message.id, readRoom: message.room,
        authorId: message.memberId, authorName: name, kind: 'mention',
        channel: room, context: room.startsWith('thread:') ? 'Thread' : `${contextFor(room)}${threadId ? ' / Thread' : ''}`,
        ...timeLabels(message.createdAt), createdAt: message.createdAt,
        text: message.body, title: `${name} mentioned you`, threadId,
      };
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export const inboxReadId = (item: Item) => item.readId || item.id;
export const isInboxRead = (item: Item, read: string[], lastRead: Record<string,string>) =>
  item.notifiable === false || read.includes(inboxReadId(item)) || read.includes(item.sourceId) || !!item.readRoom && (lastRead[item.readRoom] || '') >= item.createdAt;
const clearedId = (item: Item) => `unanswered-cleared:${inboxReadId(item)}`;
export const isInboxUnanswered = (item: Item, read: string[]) => !!item.unanswered && !read.includes(clearedId(item));

type Props = {
  /** An explicit ID opens that record; omitted IDs retain Workspace's first-pending behavior. */
  reviewDraft: (id?: string) => void;
  /** The optional second argument opens a mention's parent thread after its room. */
  openRoom: (name: string, threadId?: string) => void;
  /** Read item ids, persisted by Workspace with the rest of the per-user browser state. */
  read: string[];
  lastRead: Record<string,string>;
  setLastRead: (update: (current: Record<string,string>) => Record<string,string>) => void;
  setRead: (update: (current: string[]) => string[]) => void;
};
export function InboxView({ reviewDraft, openRoom, read, setRead, lastRead, setLastRead }: Props) {
  const members = useWorkspaceMembers();
  const { approvals, messages, runs, user, loaded, online } = useBuzz();
  const items = useMemo(() => buildInboxItems({ approvals, messages, runs, user }, members), [approvals, messages, runs, user, members]);
  // Recognize existing unprefixed read IDs from the backend fork as well.
  const readId = inboxReadId;
  const isRead = (item: Item) => isInboxRead(item, read, lastRead);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread' | 'unanswered'>('all');
  const unreadOnly = filter === 'unread';
  const [query, setQuery] = useState('');
  const [focusedId, setFocusedId] = useState('');
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const unreadCount = items.filter(
    (item) => !isRead(item),
  ).length;
  const author = (item: Item) =>
    members.find((member) => member.id === item.authorId);
  const authorName = (item: Item) =>
    author(item)?.name || item.authorName;
  const title = (item: Item) => item.title;
  const visible = items.filter(
    (item) =>
      (!unreadOnly || !isRead(item)) && (filter !== 'unanswered' || isInboxUnanswered(item, read)) &&
      `${authorName(item)} ${title(item)} ${item.text} ${item.context}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const selected = items.find((item) => item.id === selectedId);
  function markRead(item: Item) {
    const id = readId(item);
    setRead(current => current.includes(id) ? current : [...current,id]);
    if (item.readRoom) setLastRead(current => ({...current,[item.readRoom!]:current[item.readRoom!] > item.createdAt ? current[item.readRoom!] : item.createdAt}));
  }
  useEffect(() => {
    if (!selected) return;
    const markVisible = () => { if (document.visibilityState === 'visible') markRead(selected); };
    const timer = setTimeout(markVisible, 0);
    document.addEventListener('visibilitychange', markVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', markVisible); };
  }, [selectedId, selected?.readId, selected?.createdAt]); // eslint-disable-line react-hooks/exhaustive-deps
  function select(item: Item) {
    setSelectedId(item.id);
    markRead(item);
    if (unreadOnly || window.matchMedia('(max-width:760px)').matches)
      requestAnimationFrame(() =>
        detailHeading.current?.focus({ preventScroll: true }),
      );
  }
  function avatar(item: Item) {
    const member = author(item);
    return <MemberAvatar member={member} name={authorName(item)} initials={authorName(item).split(/\s+/).map((part) => part[0]).slice(0, 2).join('')} size={32} />;
  }
  return (
    <div className="page quality-inbox">
      <PageHeader
        className="page-heading"
        title="Inbox"
        action={items.length > 0 &&
          <button
            className="btn btn-secondary"
            onClick={() => {setRead(current => [...new Set([...current,...items.map(readId)])]);setLastRead(current => {const next={...current};for(const item of items)if(item.readRoom && item.createdAt > (next[item.readRoom] || ''))next[item.readRoom]=item.createdAt;return next;});}}
            disabled={!unreadCount}
          >
            <CheckCheck size={16} />
            Mark all read
          </button>
        }
      />
      <div
        className={`quality-inbox-layout ${selected ? 'has-selection' : ''} ${!visible.length && !selected ? 'is-empty' : ''}`}
      >
        <section className="quality-inbox-list" aria-label="Inbox messages">
          {items.length > 0 && <div className="quality-inbox-toolbar">
            <fieldset aria-label="Inbox filter">
              <button
                aria-pressed={filter === 'all'}
                onClick={() => {setFilter('all');setSelectedId(null);}}
              >
                All
              </button>
              <button
                aria-pressed={unreadOnly}
                onClick={() => {setFilter('unread');setSelectedId(null);}}
              >
                Unread <span>{unreadCount}</span>
              </button>
              <button aria-pressed={filter === 'unanswered'} onClick={() => {setFilter('unanswered');setSelectedId(null);}}>Unanswered</button>
            </fieldset>
            <label className="quality-inbox-search">
              <Search size={16} />
              <input
                aria-label="Search inbox"
                placeholder="Search inbox"
                value={query}
                onChange={(event) => {setQuery(event.target.value);setSelectedId(null);}}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear inbox search"
                  onClick={() => setQuery('')}
                >
                  <X size={14} />
                </button>
              )}
            </label>
          </div>}
          <ul className="quality-inbox-rows">
            {visible.map((item, index) => (
              <li key={item.id}>
                <button
                  ref={(node) => {
                    if (node) rowRefs.current.set(item.id, node);
                    else rowRefs.current.delete(item.id);
                  }}
                  className={`quality-inbox-row ${isRead(item) ? 'is-read' : 'is-unread'} ${selectedId === item.id ? 'selected' : ''}`}
                  aria-current={selectedId === item.id ? 'true' : undefined}
                  aria-label={`${title(item)}, ${isRead(item) ? 'read' : 'unread'}`}
                  aria-controls="quality-inbox-detail"
                  tabIndex={
                    focusedId === item.id ||
                    (!visible.some((value) => value.id === focusedId) &&
                      index === 0)
                      ? 0
                      : -1
                  }
                  onFocus={() => setFocusedId(item.id)}
                  onClick={() => select(item)}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === 'ArrowDown'
                        ? 1
                        : event.key === 'ArrowUp'
                          ? -1
                          : 0;
                    if (offset) {
                      event.preventDefault();
                      rowRefs.current
                        .get(
                          visible[
                            Math.max(
                              0,
                              Math.min(visible.length - 1, index + offset),
                            )
                          ].id,
                        )
                        ?.focus();
                    } else if (event.key === 'Home' || event.key === 'End') {
                      event.preventDefault();
                      rowRefs.current
                        .get(
                          visible[event.key === 'Home' ? 0 : visible.length - 1]
                            .id,
                        )
                        ?.focus();
                    }
                  }}
                >
                  {avatar(item)}
                  <span className="quality-inbox-copy">
                    <span className="quality-inbox-meta">
                      <strong>{authorName(item)}</strong>
                      <time dateTime={item.createdAt} title={item.fullTime}>{item.time}</time>
                    </span>
                    <span className="quality-inbox-title">
                      {item.title}
                    </span>
                    <span className="quality-inbox-excerpt">{item.text}</span>
                    <small>{item.context}</small>
                  </span>
                  {!isRead(item) && (
                    <span className="inbox-unread-label">New</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {!visible.length && (
            <div className="quality-inbox-empty">
              <Inbox size={26} />
              <h3>
                {query
                  ? 'No matching messages'
                  : unreadOnly
                    ? 'No unread messages'
                    : filter === 'unanswered'
                      ? 'No unanswered messages'
                    : !loaded
                      ? online ? 'Loading inbox' : 'Waiting for the workspace'
                      : 'No messages'}
              </h3>
              {query && (
                <button
                  className="btn btn-secondary"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </button>
              )}
            </div>
          )}
        </section>
        {(selected || visible.length > 0) && <section
          className="quality-inbox-detail"
          id="quality-inbox-detail"
          aria-label="Message details"
        >
          {selected ? (
            <>
              <header className="quality-inbox-detail-toolbar">
                <button
                  className="quality-inbox-back"
                  aria-label="Back to inbox"
                  onClick={() => {
                    setSelectedId(null);
                    requestAnimationFrame(() => (rowRefs.current.get(selected.id) || rowRefs.current.get(visible[0]?.id))?.focus());
                  }}
                >
                  <ArrowLeft size={18} />
                </button>
                <span>{selected.context}</span>
                {selected.notifiable !== false && <button
                  className="quality-inbox-read-action"
                  onClick={() => {
                    if (!isRead(selected)) {markRead(selected);return;}
                    setRead(current => current.filter(id => id !== readId(selected) && id !== selected.sourceId));
                    if (selected.readRoom) setLastRead(current => ({...current,[selected.readRoom!]:new Date(Date.parse(selected.createdAt)-1).toISOString()}));
                  }}
                >
                  {isRead(selected) ? (
                    <Mail size={16} />
                  ) : (
                    <MailOpen size={16} />
                  )}
                  Mark {isRead(selected) ? 'unread' : 'read'}
                </button>}
              </header>
              <article className="quality-inbox-message">
                <div className="quality-inbox-message-author">
                  {avatar(selected)}
                  <strong>{authorName(selected)}</strong>
                  <time dateTime={selected.createdAt} title={selected.fullTime}>{selected.time}</time>
                </div>
                <h2 ref={detailHeading} tabIndex={-1}>
                  {selected.title}
                </h2>
                <p>{selected.text}</p>
                <div className="connection-actions">
                <button
                  className="btn btn-primary"
                  disabled={selected.kind === 'mention' && selected.channel.startsWith('thread:')}
                  title={selected.kind === 'mention' && selected.channel.startsWith('thread:') ? 'The parent conversation is not loaded yet.' : undefined}
                  onClick={() => {
                    markRead(selected);
                    if (selected.approvalId) reviewDraft(selected.approvalId);
                    else openRoom(selected.channel.startsWith('dm:') ? selected.channel.slice(3) : selected.channel, selected.threadId);
                  }}
                >
                  {selected.kind === 'review'
                    ? selected.approvalStatus === 'Pending' ? 'Review action' : 'View decision'
                    : 'Open conversation'}
                  <ArrowUpRight size={15} />
                </button>
                {selected.unanswered && <button className="btn btn-secondary" onClick={() => {
                  const id = clearedId(selected), clearing = isInboxUnanswered(selected, read);
                  setRead(current => clearing ? [...new Set([...current, id])] : current.filter(value => value !== id));
                  if (clearing && filter === 'unanswered') setSelectedId(null);
                }}>{isInboxUnanswered(selected, read) ? 'Clear unanswered' : 'Restore unanswered'}</button>}
                </div>
              </article>
            </>
          ) : (
            <div className="quality-inbox-empty">
              <Inbox size={28} />
              <h2>Select a message</h2>
            </div>
          )}
        </section>}
      </div>
    </div>
  );
}
