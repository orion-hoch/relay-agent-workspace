'use client';

import { ChatDeepDiveActivity, ChatDeepDiveControl } from './components/ChatDeepDiveControl';
import './components/chat-deep-dive.css';
import { DeepDiveAvatar } from '@/components/DeepDiveAvatar';
import './components/deep-dive-avatar.css';
import type { RunMode } from '@/lib/buzz/types';
import { buzz, useBuzz } from '@/lib/buzz/store';
import { useWorkspaceSetting } from '@/lib/buzz/use-workspace-setting';
import {
  AgentAvatar,
  setAgentActivity,
  setAgentAvailability,
} from '@/components/AgentAvatar';
import { SettingsView } from './components/SettingsView';
import { InboxView } from './components/InboxView';
import { useWorkspaceName } from '@/lib/workspace-name';
import { HuddlesView } from './components/HuddlesView';
import {
  useWorkspaceMembers,
  type WorkspaceMember,
} from '@/lib/workspace-members';
import { LiveComposer, type ComposerHandle } from './LiveComposer';
import './live-chat.css';
import { MemberAvatar } from '@/components/MemberAvatar';
import { useAgentHomes } from '@/lib/agent-homes';
import './chat-quality.css';
import { ChatHeader } from '@/components/buzz/ChatHeader';

import { isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent, CSSProperties } from 'react';
import {
  Archive,
  AtSign,
  Bold,
  Code,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  Database,
  FileText,
  Hash,
  Inbox,
  Info,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Smile,
  Star,
  Users,
  ThumbsUp,
  X,
  Zap,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  SidebarProvider,
  useSidebar,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataView } from './components/DataView';
import { ComputeView } from './components/ComputeView';

type View =
  | 'chat'
  | 'inbox'
  | 'agents'
  | 'data'
  | 'compute'
  | 'huddles'
  | 'settings';
type Message = {
  id: string;
  runId?: string;
  name: string;
  initials: string;
  tone: string;
  time: string;
  body: ReactNode;
  agent?: 'local' | 'cloud';
  reactions?: number;
  replies?: number;
  memberId?: string;
  requestState?: 'pending' | 'error' | 'complete';
  error?: string;
  attachment?: { name: string; detail: string };
};
function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node))
    return plainText(node.props.children);
  return '';
}
function resolveMember(
  members: readonly WorkspaceMember[],
  id?: string,
  name?: string,
) {
  return id
    ? members.find((member) => member.id === id)
    : members.find((member) => member.name === name);
}
function MemberClearance({ member }: { member?: WorkspaceMember }) {
  return member?.kind === 'agent' ? (
    <span className="member-clearance">
      ({member.accessLevel.toLowerCase()})
    </span>
  ) : null;
}
function messageText(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|@[\w-]+)/g).map((part, index) =>
    part.startsWith('**') ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : part.startsWith('@') ? (
      <span className="mention" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function NavigationContent({ children }: { children: ReactNode }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarContent
      className="rail-content"
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('.rail-link')
        )
          setOpenMobile(false);
      }}
    >
      {children}
    </SidebarContent>
  );
}
export function Workspace() {
  const members = useWorkspaceMembers();
  const workspaceName = useWorkspaceName();
  const [, setMentionedIds] = useState<string[]>([]);
  const [memberProfile, setMemberProfile] = useState<WorkspaceMember | null>(
    null,
  );

  const [view, setView] = useState<View>('chat');
  const [channel, setChannel] = useState('');
  const [runModes, setRunModes] = useState<Record<string, RunMode>>({});
  const {
    messages: sharedMessages,
    channels: sharedChannels,
    runs,
    approvals,
    loaded: sharedLoaded,
  } = useBuzz();
  const channels = sharedChannels;
  useEffect(() => {
    if (!channel && channels.length) setChannel(channels[0]);
  }, [channel, channels]);
  const messagesByRoom = useMemo(() => {
    const rooms: Record<string, Message[]> = {};
    for (const record of sharedMessages) {
      const member = resolveMember(members, record.memberId, record.name);
      const message: Message = {
        id: record.id,
        runId: record.runId ?? undefined,
        name: member?.name ?? record.name,
        memberId: record.memberId,
        initials: member?.initials ?? record.name.slice(0, 2),
        tone: member?.tone ?? 'mint',
        body: record.body,
        time: new Date(record.createdAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        }),
        agent: member?.kind === 'agent' ? member.runtime : undefined,
        requestState: record.state ?? undefined,
        error: record.error ?? undefined,
        attachment: record.attachment ?? undefined,
      };
      (rooms[record.room] ??= []).push(message);
    }
    return rooms;
  }, [sharedMessages, members]);
  const messages = messagesByRoom[channel] ?? [];
  useEffect(() => {
    for (const member of members) {
      if (member.kind !== 'agent') continue;
      const own = runs.filter((run) => run.agentId === member.id);
      const active = own.some((run) =>
        ['preparing', 'running'].includes(run.status),
      );
      const latest = [...own].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0];
      setAgentActivity(
        member.id,
        member.paused
          ? 'paused'
          : active
            ? 'working'
            : own.some(run => run.status === 'awaiting') || latest?.status === 'failed'
              ? 'blocked'
              : 'ready',
      );
    }
  }, [members, runs]);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState('');
  useEffect(() => {
    const notice = (event: Event) => setToast(String((event as CustomEvent).detail));
    window.addEventListener('shoal:notice', notice);
    return () => window.removeEventListener('shoal:notice', notice);
  }, []);
  const homes = useAgentHomes();
  useEffect(() => {
    members.forEach((member) => {
      if (member.kind === 'agent')
        setAgentAvailability(
          member.id,
          homes.some(
            (home) => home.id === member.homeId && home.status === 'connected',
          ),
          member.paused === true,
          member.character,
        );
    });
  }, [homes, members]);
  const [threadSnapshot, setThread] = useState<Message | null>(null);
  const thread = threadSnapshot
    ? (Object.values(messagesByRoom)
        .flat()
        .find((message) => message.id === threadSnapshot.id) ?? threadSnapshot)
    : null;
  const [starred, setStarred] = useState(false);
  const [tab, setTab] = useState('messages');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [newChannel, setNewChannel] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [canvases, setCanvases] = useWorkspaceSetting<Record<string, string>>('canvases', {});
  const canvas = canvases[channel] ?? '';
  const setCanvas = (value: string) =>
    setCanvases((all) => ({ ...all, [channel]: value }));
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const activeApproval =
    approvals.find(item => item.id === selectedApprovalId) ?? approvals.find((item) => item.status === 'Pending') ?? approvals[0];
  const approval = activeApproval?.status ?? 'No pending review';
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalActionable = !!activeApproval && activeApproval.status === 'Pending' && !activeApproval.receipt
    && (!activeApproval.expiresAt || Date.parse(activeApproval.expiresAt) > Date.now());
  const [replies, setReplies] = useState<Record<string, string[]>>({});
  const [preferences, setPreferences] = useState([true, false, true]);
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>(
    {},
  );
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem('relay-workspace-v1');
        if (saved) {
          const data = JSON.parse(saved) as {
            replies?: Record<string, string[]>;
            reactions?: Record<string, number>;
            preferences?: boolean[];
            draft?: string;
          };
          if (data.replies) setReplies(data.replies);
          if (data.reactions) setReactionCounts(data.reactions);
          if (data.preferences?.length === 3) setPreferences(data.preferences);
          if (typeof data.draft === 'string') setDraft(data.draft);
        }
      } catch {
        /* Preferences are optional if storage is unavailable. */
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        'relay-workspace-v1',
        JSON.stringify({
          replies,
          reactions: reactionCounts,
          preferences,
          draft,
        }),
      );
    } catch {
      /* Session state remains usable if browser storage is full. */
    }
  }, [hydrated, replies, reactionCounts, preferences, draft]);
  const currentRef = useRef({ channel, view });
  useEffect(() => {
    currentRef.current = { channel, view };
  }, [channel, view]);
  const [dm, setDm] = useState<string | null>(null);
  const [threadReply, setThreadReply] = useState('');
  const threadComposerRef = useRef<ComposerHandle>(null);
  const [panelWidth, setPanelWidth] = useState(390);
  const panelRef = useRef<HTMLElement>(null);
  const threadMessages = thread
    ? (messagesByRoom[`thread:${thread.id}`] ?? [])
    : [];
  const openThread = (message: Message) => {
    setMemberProfile(null);
    setThread(message);
    setThreadReply('');
  };
  const openProfile = (member: WorkspaceMember) => {
    setThread(null);
    setMemberProfile(member);
  };
  useEffect(() => {
    if (!threadSnapshot && !memberProfile) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setThread(null);
        setMemberProfile(null);
        previous?.focus();
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [threadSnapshot, memberProfile]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!preferences[2]) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preferences]);
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool?: (
            tool: unknown,
            options?: { signal?: AbortSignal },
          ) => unknown;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    const allowed = new Set<View>([
      'chat',
      'inbox',
      'agents',
      'data',
      'compute',
      'huddles',
      'settings',
    ]);
    const result = (value: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(value) }],
    });
    try {
      Promise.resolve(
        context.registerTool(
          {
            name: 'navigate_workspace',
            description: 'Navigate the Shoal workspace.',
            inputSchema: {
              type: 'object',
              properties: { view: { type: 'string', enum: [...allowed] } },
              required: ['view'],
            },
            execute: async (
              input: unknown,
              options?: { signal?: AbortSignal },
            ) => {
              const next = (input as { view?: unknown })?.view;
              if (
                options?.signal?.aborted ||
                typeof next !== 'string' ||
                !allowed.has(next as View)
              )
                throw new Error('Invalid workspace view');
              setView(
                (next === 'agents'
                  ? 'compute'
                  : next === 'deep-dive'
                    ? 'chat'
                    : next) as View,
              );
              return result({ view: next, localOnly: true });
            },
          },
          { signal: controller.signal },
        ),
      ).catch(() => {});
      Promise.resolve(
        context.registerTool(
          {
            name: 'read_workspace',
            description: 'Read a non-sensitive summary of the Shoal workspace.',
            inputSchema: { type: 'object', properties: {} },
            execute: async (
              _input: unknown,
              options?: { signal?: AbortSignal },
            ) => {
              if (options?.signal?.aborted) throw new Error('Aborted');
              return result({
                workspace: workspaceName,
                ...currentRef.current,
                localOnly: true,
                serversConnected: false,
              });
            },
          },
          { signal: controller.signal },
        ),
      ).catch(() => {});
    } catch {
      /* WebMCP is optional and browser support is not assumed. */
    }
    return () => controller.abort();
  }, []);
  const notify = (message: string) => setToast(message);
  const navigate = (next: string) => {
    setView(
      (next === 'agents'
        ? 'compute'
        : next === 'deep-dive'
          ? 'chat'
          : next) as View,
    );
  };
  const results = Object.entries(messagesByRoom)
    .filter(([room]) => !room.startsWith('thread:'))
    .flatMap(([room, items]) => items.map((message) => ({ ...message, room })))
    .filter(
      (message) =>
        !search.trim() ||
        `${message.name} ${plainText(message.body)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .slice(-100)
    .reverse();
  function openRoom(name: string) {
    const member = members.find(
      (person) => person.id === name || person.name === name,
    );
    const room = member ? `dm:${member.id}` : name;
    setThread(null);
    setMemberProfile(null);
    setChannel(room);
    setDm(member?.id ?? null);

    setDraft('');
    setMentionedIds([]);
    setTab('messages');
    setView('chat');
  }
  function retryMessage(message: Message, _room?: string) {
    if (!message.runId) return notify('No recorded run to retry.');
    void buzz
      .retryRun(message.runId)
      .catch((error: unknown) =>
        notify(
          error instanceof Error
            ? error.message
            : 'Could not retry this response.',
        ),
      );
  }
  function send() {
    const text = draft.trim();
    if (!text || !channel) return;
    if (!sharedLoaded) return notify('The shared workspace is still connecting. Try again shortly.');
    const room = channel;
    setDraft('');
    setMentionedIds([]);
    void buzz
      .sendMessage(room, text, crypto.randomUUID(), runModes[room] ?? 'quick')
      .catch((error: unknown) => {
        if (currentRef.current.channel === room)
          setDraft((value) => value || text);
        notify(
          error instanceof Error
            ? error.message
            : 'Message not sent. Try again.',
        );
      });
  }
  const activeThreadId = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeThreadId.current = thread?.id;
  }, [thread?.id]);
  function sendThread() {
    const text = threadReply.trim();
    if (!text || !thread) return;
    if (!sharedLoaded) return notify('The shared workspace is still connecting. Try again shortly.');
    const threadId = thread.id;
    setThreadReply('');
    void buzz
      .sendMessage(`thread:${threadId}`, text, crypto.randomUUID(), runModes[`thread:${threadId}`] ?? 'quick')
      .catch((error: unknown) => {
        if (activeThreadId.current === threadId)
          setThreadReply((value) => value || text);
        notify(
          error instanceof Error ? error.message : 'Reply not sent. Try again.',
        );
      });
  }
  async function decideApproval(decision: 'Approved' | 'Rejected') {
    if (!activeApproval || approvalBusy || !approvalActionable) return;
    setApprovalBusy(true);
    try {
      await buzz.decide(activeApproval.id, decision, activeApproval.action);
      setApprovalOpen(false);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'Could not save the decision.',
      );
    } finally {
      setApprovalBusy(false);
    }
  }
  async function addChannel(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = channelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    try {
      await buzz.createChannel(name);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create channel.');
      return;
    }

    setDm(null);
    setChannel(name);
    setChannelName('');
    setNewChannel(false);
    setView('chat');
  }
  const nav = (
    icon: ReactNode,
    label: string,
    target: View,
    count?: string,
  ) => (
    <SidebarMenuItem key={label}>
      <SidebarMenuButton
        className="rail-link"
        data-active={view === target}
        onClick={() => navigate(target)}
      >
        {icon}
        <span>{label}</span>
        {count && <span className="nav-count">{count}</span>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  return (
    <SidebarProvider
      defaultOpen
      className={`relay-shell ${preferences[1] ? 'compact' : ''}`}
    >
      {preferences[1] && (
        <style>{`.relay-shell.compact .message-row{padding-top:6px;padding-bottom:6px}.relay-shell.compact .message-body p{line-height:1.35}.relay-shell.compact .avatar{width:30px;height:30px}`}</style>
      )}
      <Sidebar className="relay-sidebar" collapsible="offcanvas">
        <SidebarHeader className="rail-header">
          <div className="brand">
            <span className="brand-symbol">
              <Zap size={19} />
            </span>
            Shoal<span className="brand-period">.</span>
            <span className="brand-version">PREVIEW</span>
          </div>
          <button
            className="workspace-switch"
            onClick={() => setProfileOpen(true)}
          >
            <span className="workspace-avatar">M</span>
            <span>
              <strong>{workspaceName}</strong>
              <small>Workspace</small>
            </span>
            <ChevronDown size={15} />
          </button>
        </SidebarHeader>
        <NavigationContent>
          <button className="rail-search" onClick={() => setSearchOpen(true)}>
            <Search size={16} />
            <span>Search</span>
            <kbd>⌘ K</kbd>
          </button>
          <SidebarMenu>
            {nav(<Inbox size={17} />, 'Inbox', 'inbox')}
            {nav(<Database size={17} />, 'Data', 'data')}
            {nav(<Cpu size={17} />, 'Habitats', 'compute')}
          </SidebarMenu>
          <div className="rail-section-label">
            <span>CHANNELS</span>
            <button
              className="icon-btn"
              aria-label="New channel"
              onClick={() => setNewChannel(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <SidebarMenu>
            {channels.map((name) => (
              <SidebarMenuItem key={name}>
                <SidebarMenuButton
                  className="rail-link"
                  data-active={view === 'chat' && channel === name}
                  onClick={() => {
                    openRoom(name);
                  }}
                >
                  <Hash size={16} />
                  <span>{name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="rail-section-label">
            <span>WORKSPACE</span>
          </div>
          <SidebarMenu>
            {nav(<Users size={16} />, 'Huddles', 'huddles')}
            {nav(<Settings size={16} />, 'Settings', 'settings')}
          </SidebarMenu>
          <div className="rail-section-label">
            <span>DIRECT MESSAGES</span>
            <button
              className="icon-btn"
              aria-label="New direct message"
              onClick={() => setPeopleOpen(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <SidebarMenu>
            {members
              .filter((member) => member.id !== 'you')
              .map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton
                    className="rail-link"
                    data-active={view === 'chat' && dm === p.id}
                    onClick={() => openRoom(p.id)}
                  >
                    <MemberAvatar member={p} size={24} />
                    <span>{p.name.split(' ')[0]}</span>
                    <span className="rail-dot" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
          </SidebarMenu>
        </NavigationContent>
        <SidebarFooter className="rail-footer">
          <button className="compute-mini" onClick={() => navigate('compute')}>
            <Cpu size={17} className="compute-chip" />
            <span>
              <strong>Dell GB10</strong>
              <small>
                <span className="status-dot" />{' '}
                {homes.find((home) => home.id === 'lab')?.status === 'connected'
                  ? 'Connected'
                  : 'Setting up'}
              </small>
            </span>
          </button>
          <div className="rail-profile">
            <button onClick={() => setProfileOpen(true)}>
              <MemberAvatar
                member={members.find((m) => m.id === 'you')}
                size={24}
              />
              <span>
                <strong>Your profile</strong>
                <small>Local</small>
              </span>
            </button>
            <button
              className="icon-btn"
              aria-label="Help"
              onClick={() =>
                notify('Use @ to mention a member, or open a direct message.')
              }
            >
              <CircleHelp size={16} />
            </button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main
        className={`workspace-main ${view === 'chat' && (thread || memberProfile) ? 'workspace-has-panel' : ''}`}
        style={{ '--detail-pane-width': `${panelWidth}px` } as CSSProperties}
      >
        <header
          className="topbar"
          style={{ display: view === 'chat' ? 'none' : undefined }}
        >
          <div className="breadcrumbs">
            <SidebarTrigger className="mobile-menu" />
            <strong>
              {view === 'chat'
                ? `${dm ? '@' : '#'} ${channel}`
                : view === 'compute'
                  ? 'Habitats'
                  : view[0].toUpperCase() + view.slice(1)}
            </strong>
            <span>/</span>
            <span>{workspaceName}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-btn"
              aria-label="Notifications"
              onClick={() => navigate('inbox')}
            >
              <AtSign size={17} />
              <span className="notification-dot" />
            </button>
            <button
              className="top-profile"
              onClick={() => setProfileOpen(true)}
              aria-label="Open profile"
            >
              <MemberAvatar
                member={members.find((m) => m.id === 'you')}
                size={26}
              />
            </button>
          </div>
        </header>
        <div
          style={{ display: view === 'chat' ? 'contents' : 'none' }}
          aria-hidden={view !== 'chat'}
        >
          <Chat
            room={channel}
            runMode={runModes[channel] ?? 'quick'}
            setRunMode={mode => setRunModes(current => ({...current, [channel]: mode}))}
            channel={
              members.find((member) => member.id === dm)?.name ?? channel
            }
            members={members}
            onMention={(id) =>
              setMentionedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
            }
            retry={retryMessage}
            openMember={openProfile}
            dm={!!dm}
            recipient={members.find((member) => member.id === dm)}
            approval={approval}
            reviewDraft={(id) => { setSelectedApprovalId(id ?? null); setApprovalOpen(true); }}
            invite={() => setPeopleOpen(true)}
            reactionCounts={reactionCounts}
            react={(id) =>
              setReactionCounts((all) => ({ ...all, [id]: (all[id] || 0) + 1 }))
            }
            replies={Object.fromEntries(
              messages.map((message) => [
                message.id,
                [
                  ...(replies[message.id] ?? []),
                  ...(messagesByRoom[`thread:${message.id}`] ?? []).map(
                    (reply) => plainText(reply.body),
                  ),
                ],
              ]),
            )}
            tab={tab}
            setTab={setTab}
            messages={messages}
            draft={draft}
            setDraft={setDraft}
            send={send}
            starred={starred}
            setStarred={setStarred}
            setThread={openThread}
            canvas={canvas}
            setCanvas={setCanvas}
            navigate={navigate}
            notify={notify}
          />
        </div>
        <View
          view={view}
          navigate={navigate}
          notify={notify}
          preferences={preferences}
          setPreferences={setPreferences}
          reviewDraft={(id) => { setSelectedApprovalId(id ?? null); setApprovalOpen(true); }}
          openRoom={(room, threadId) => { openRoom(room); if (threadId) { const parent = Object.values(messagesByRoom).flat().find(message => message.id === threadId); if (parent) openThread(parent); } }}
        />
        {view === 'chat' && (thread || memberProfile) && (
          <aside
            ref={panelRef}
            tabIndex={-1}
            className="conversation-detail-pane"
            aria-label={thread ? 'Thread' : 'Member profile'}
          >
            {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable adjustable separator implements the ARIA window splitter pattern. */}
            <div
              className="detail-pane-resizer"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Interactive keyboard-adjustable window splitter.
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize details"
              tabIndex={0}
              aria-valuemin={320}
              aria-valuemax={560}
              aria-valuenow={panelWidth}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setPanelWidth((width) =>
                    Math.max(
                      320,
                      Math.min(
                        560,
                        width + (event.key === 'ArrowLeft' ? 20 : -20),
                      ),
                    ),
                  );
                }
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                const handle = event.currentTarget;
                handle.setPointerCapture(event.pointerId);
                const start = event.clientX,
                  width = panelWidth;
                const move = (e: PointerEvent) =>
                  setPanelWidth(
                    Math.max(320, Math.min(560, width + start - e.clientX)),
                  );
                const end = () => {
                  handle.removeEventListener('pointermove', move);
                  handle.removeEventListener('pointerup', end);
                  handle.removeEventListener('pointercancel', end);
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', end);
                handle.addEventListener('pointercancel', end);
              }}
            />
            <header className="detail-pane-header">
              <h2>{thread ? 'Thread' : 'Profile'}</h2>
              <button
                className="icon-btn"
                aria-label="Close details"
                onClick={() => {
                  setThread(null);
                  setMemberProfile(null);
                }}
              >
                <X size={18} />
              </button>
            </header>
            {thread ? (
              <>
                <div className="detail-pane-scroll">
                  <div className="thread-message">
                    <DeepDiveAvatar
                      runId={thread.runId}
                      author={resolveMember(
                        members,
                        thread.memberId,
                        thread.name,
                      )}
                      name={thread.name}
                      initials={thread.initials}
                      size={36}
                    />
                    <div>
                      <div className="message-meta">
                        <strong>
                          {resolveMember(members, thread.memberId, thread.name)
                            ?.name ?? thread.name}
                        </strong>
                        <MemberClearance
                          member={resolveMember(
                            members,
                            thread.memberId,
                            thread.name,
                          )}
                        />
                        <time>{thread.time}</time>
                      </div>
                      <div className="message-text">
                        {typeof thread.body === 'string'
                          ? messageText(thread.body)
                          : thread.body}
                      </div>
                    </div>
                  </div>
                  <div className="thread-reply-divider">
                    {(replies[thread.id]?.length ?? 0) +
                      threadMessages.length}{' '}
                    replies
                  </div>
                  {(replies[thread.id] ?? []).map((reply, index) => (
                    <div className="thread-message" key={`old-${index}`}>
                      <MemberAvatar
                        member={members.find((m) => m.id === 'you')}
                        size={36}
                      />
                      <div>
                        <div className="message-meta">
                          <strong>You</strong>
                        </div>
                        <div className="message-text">{reply}</div>
                      </div>
                    </div>
                  ))}
                  {threadMessages.map((reply) => (
                    <div className="thread-message" key={reply.id}>
                      <DeepDiveAvatar
                        runId={reply.runId}
                        author={members.find((m) => m.id === reply.memberId)}
                        name={reply.name}
                        initials={reply.initials}
                        size={36}
                      />
                      <div>
                        <div className="message-meta">
                          <strong>
                            {resolveMember(members, reply.memberId, reply.name)
                              ?.name ?? reply.name}
                          </strong>
                          <MemberClearance
                            member={resolveMember(
                              members,
                              reply.memberId,
                              reply.name,
                            )}
                          />
                          <time>{reply.time}</time>
                        </div>
                        <div className="message-text">
                          {typeof reply.body === 'string'
                            ? messageText(reply.body)
                            : reply.body}
                        </div>
                        {reply.requestState === 'pending' && (
                          <output className="message-request-state">
                            Responding…{' '}
                          </output>
                        )}
                        {reply.requestState === 'error' && (
                          <div className="message-request-state" role="alert">
                            {reply.error}
                            <button
                              onClick={() =>
                                retryMessage(reply, `thread:${thread.id}`)
                              }
                            >
                              Retry
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <ChatDeepDiveActivity room={`thread:${thread.id}`} />
                <div className="thread-composer composer">
                  <LiveComposer
                    ref={threadComposerRef}
                    value={threadReply}
                    onChange={setThreadReply}
                    onSend={sendThread}
                    members={members}
                    onMention={() => {}}
                    placeholder="Reply in thread…"
                  />
                  <div className="composer-bottom">
                    <div>
                      <button
                        className="icon-btn"
                        aria-label="Mention in thread"
                        onClick={() =>
                          threadComposerRef.current?.insertText('@')
                        }
                      >
                        <AtSign size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label="Add emoji to reply"
                        onClick={() =>
                          threadComposerRef.current?.insertText(' 🙂')
                        }
                      >
                        <Smile size={16} />
                      </button>
                      <ChatDeepDiveControl mode={runModes[`thread:${thread.id}`] ?? 'quick'} onChange={mode => setRunModes(current => ({...current, [`thread:${thread.id}`]: mode}))} />
                    </div>
                    <button
                      className="send-button"
                      disabled={!threadReply.trim()}
                      aria-label="Send reply"
                      onClick={sendThread}
                    >
                      <Send size={15} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              memberProfile && (
                <div className="member-profile-panel">
                  <MemberAvatar member={memberProfile} size={104} />
                  <h2>{memberProfile.name}</h2>
                  <button
                    className="btn btn-secondary"
                    onClick={() => openRoom(memberProfile.id)}
                  >
                    <MessageCircle size={16} /> Message
                  </button>
                  {memberProfile.kind === 'agent' && (
                    <>
                      <dl>
                        <div>
                          <dt>Home</dt>
                          <dd>
                            {memberProfile.runtime === 'local'
                              ? 'Dell GB10'
                              : 'Cloud'}
                          </dd>
                        </div>
                        <div>
                          <dt>Access</dt>
                          <dd>{memberProfile.accessLevel}</dd>
                        </div>
                      </dl>
                      {memberProfile.instructions && (
                        <section>
                          <h3>Instructions</h3>
                          <p>{memberProfile.instructions}</p>
                        </section>
                      )}
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          const agentId = memberProfile.id;
                          setMemberProfile(null);
                          navigate('agents');
                          requestAnimationFrame(() =>
                            window.dispatchEvent(
                              new CustomEvent('relay:open-agent', {
                                detail: { agentId },
                              }),
                            ),
                          );
                        }}
                      >
                        Edit profile
                      </button>
                    </>
                  )}
                </div>
              )
            )}
          </aside>
        )}
      </main>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="search-dialog">
          <DialogHeader>
            <DialogTitle>Search Shoal</DialogTitle>
            <DialogDescription className="sr-only">
              Search messages.
            </DialogDescription>
          </DialogHeader>
          <div className="search-input">
            <Search size={18} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search messages…"
            />
            <kbd>ESC</kbd>
          </div>
          <div className="search-results">
            {results.length === 0 && (
              <p className="search-empty">No messages found.</p>
            )}
            {results.map((m) => (
              <button
                key={`${m.room}-${m.id}`}
                onClick={() => {
                  setSearchOpen(false);
                  openRoom(m.room.startsWith('dm:') ? m.room.slice(3) : m.room);
                  openThread(m);
                }}
              >
                <MemberAvatar
                  member={resolveMember(members, m.memberId, m.name)}
                  name={m.name}
                  initials={m.initials}
                  size={24}
                />
                <span>
                  <strong>
                    {m.name}:{' '}
                    {typeof m.body === 'string' ? m.body : 'Launch room update'}
                  </strong>
                  <small>
                    {m.room.startsWith('dm:')
                      ? (members.find((person) => person.id === m.room.slice(3))
                          ?.name ?? 'Direct message')
                      : `#${m.room}`}{' '}
                    · {m.time}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={peopleOpen} onOpenChange={setPeopleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Members</DialogTitle>
            <DialogDescription className="sr-only">
              Choose a conversation.
            </DialogDescription>
          </DialogHeader>
          {members
            .filter((person) => person.id !== 'you')
            .map((person) => (
              <button
                className="list-row"
                key={person.id}
                onClick={() => {
                  openRoom(person.id);
                  setPeopleOpen(false);
                }}
              >
                <MemberAvatar member={person} size={32} />
                <strong>{person.name}</strong>
                <MessageCircle size={16} />
              </button>
            ))}
        </DialogContent>
      </Dialog>
      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeApproval?.title ?? 'Review'}</DialogTitle>
            <DialogDescription>
              {activeApproval
                ? `${activeApproval.agent} · ${activeApproval.level}`
                : 'No pending review'}
            </DialogDescription>
          </DialogHeader>
          <p>{activeApproval?.body ?? 'There are no review requests.'}</p>
          <span className="badge">{approval}</span>
          {activeApproval && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: 240,
                overflow: 'auto',
              }}
            >
              {activeApproval.action}
            </pre>
          )}
          <DialogFooter>
            <button
              className="btn btn-secondary"
              disabled={approvalBusy || !approvalActionable}
              onClick={() => {
                void decideApproval('Rejected');
              }}
            >
              Reject
            </button>
            <button
              className="btn btn-primary"
              disabled={approvalBusy || !approvalActionable}
              onClick={() => {
                void decideApproval('Approved');
              }}
            >
              Approve
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newChannel} onOpenChange={setNewChannel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a channel</DialogTitle>
            <DialogDescription className="sr-only">
              Name your channel.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addChannel}>
            <label className="field">
              <span className="field-label">Channel name</span>
              <input
                className="input"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="e.g. product-launch"
              />
            </label>
            <DialogFooter>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setNewChannel(false)}
              >
                Cancel
              </button>
              <button className="btn btn-primary" type="submit">
                Create channel
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent>
          <div className="profile-preview">
            <MemberAvatar
              member={members.find((m) => m.id === 'you')}
              size={64}
            />
            <DialogTitle>Your profile</DialogTitle>
            <p className="muted">{workspaceName} workspace</p>
          </div>
          <DialogFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setProfileOpen(false)}
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && (
        <div className="relay-toast">
          <CheckCircle2 size={17} />
          <span>{toast}</span>
          <button
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </SidebarProvider>
  );
}

function Chat({
  room,
  runMode,
  setRunMode,
  members,
  onMention,
  retry,
  stop,
  openMember,
  recipient,
  dm,
  approval,
  reviewDraft,
  invite,
  reactionCounts,
  react,
  replies,
  channel,
  tab,
  setTab,
  messages,
  draft,
  setDraft,
  send,
  starred,
  setStarred,
  setThread,
  canvas,
  setCanvas,
  navigate,
  notify,
}: {
  room: string;
  runMode: RunMode;
  setRunMode: (mode: RunMode) => void;
  recipient?: WorkspaceMember;
  members: readonly WorkspaceMember[];
  onMention: (id: string) => void;
  retry: (message: Message) => void;
  stop?: (id: string) => void;
  openMember: (member: WorkspaceMember) => void;
  dm: boolean;
  approval: string;
  reviewDraft: (id?: string) => void;
  invite: () => void;
  reactionCounts: Record<string, number>;
  react: (id: string) => void;
  replies: Record<string, string[]>;
  channel: string;
  tab: string;
  setTab: (value: string) => void;
  messages: Message[];
  draft: string;
  setDraft: (value: string) => void;
  send: () => void;
  starred: boolean;
  setStarred: (value: boolean) => void;
  setThread: (message: Message) => void;
  canvas: string;
  setCanvas: (value: string) => void;
  navigate: (value: string) => void;
  notify: (message: string) => void;
}) {
  const { documents, approvals } = useBuzz();
  const roomAgents = members.filter(member => member.kind === 'agent'
    && (member.id === recipient?.id || messages.some(message => message.memberId === member.id)));
  const roomDocuments = documents.filter(document => messages.some(message => message.attachment?.name === document.name));
  const messageApproval = (message: Message) => message.runId ? approvals.find(item => item.runId === message.runId && item.status === 'Pending'
    && !item.receipt && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())) : undefined;
  const [contextOpen, setContextOpen] = useState(false);
  const [composerMenu, setComposerMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const followingMessages = useRef(true);
  useEffect(() => {
    followingMessages.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel, tab]);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && followingMessages.current)
      element.scrollTop = element.scrollHeight;
  }, [messages]);
  const insertText = (text: string) => {
    composerRef.current?.insertText(text);
  };
  const formatSelection = () => {
    const field = composerRef.current;
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? draft.length;
    const selection = draft.slice(start, end) || 'bold text';
    insertText(`**${selection}**`);
  };

  return (
    <section className="chat-page">
      <ChatHeader
        title={channel}
        onTitleClick={recipient ? () => openMember(recipient) : undefined}
        leadingContent={
          <>
            <SidebarTrigger className="mobile-menu" />
            {recipient ? (
              <button
                className="dm-header-avatar"
                aria-label={`View ${recipient.name}'s profile`}
                onClick={() => openMember(recipient)}
              >
                <MemberAvatar member={recipient} size={32} />
              </button>
            ) : (
              <Hash size={18} />
            )}
          </>
        }
        titleAdornment={
          <button
            className={`icon-btn star-button ${starred ? 'starred' : ''}`}
            aria-label={dm ? 'Star conversation' : 'Star channel'}
            onClick={() => setStarred(!starred)}
          >
            <Star size={15} fill={starred ? 'currentColor' : 'none'} />
          </button>
        }
        actions={
          <div className="channel-actions">
            {!dm && (
              <div className="member-stack">
                {members.slice(0, 3).map((p) => (
                  <MemberAvatar key={p.id} member={p} size={24} />
                ))}
                <span className="member-number">{members.length}</span>
              </div>
            )}
            {!dm && (
              <button
                className="btn btn-secondary desktop-only"
                onClick={invite}
              >
                <Users size={15} /> People
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="Toggle room context"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen(!contextOpen)}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        }
      />
      <div className="channel-tab-row">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="channel-tabs">
            <TabsTrigger value="messages">
              <MessageCircle size={14} />
              Messages
            </TabsTrigger>
            <TabsTrigger value="canvas">
              <FileText size={14} />
              Canvas
            </TabsTrigger>
            <TabsTrigger value="files">
              <Archive size={14} />
              Files
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === 'messages' ? (
        <div
          className={`conversation-layout ${contextOpen ? 'context-open' : ''}`}
          style={{
            gridTemplateColumns: contextOpen ? undefined : 'minmax(0, 1fr)',
          }}
        >
          <div className="conversation">
            <div
              className="conversation-scroll"
              ref={scrollRef}
              onScroll={(event) => {
                const el = event.currentTarget;
                followingMessages.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {recipient && (
                <div className="dm-conversation-intro">
                  <button
                    aria-label={`Open ${recipient.name}'s profile`}
                    onClick={() => openMember(recipient)}
                  >
                    <MemberAvatar member={recipient} size={72} />
                  </button>
                  <h2>{recipient.name}</h2>
                  <p>This is your conversation with {recipient.name}.</p>
                </div>
              )}
              {messages.length > 0 && <div className="date-divider">Today</div>}
              {messages.map((m, index) => (
                <article
                  className={`message-row ${messages[index - 1]?.name === m.name && !m.runId ? 'message-grouped' : ''}`}
                  key={m.id}
                >
                  <button
                    className="message-avatar-button"
                    aria-label={`View ${m.name}'s profile`}
                    onClick={() => {
                      const person = resolveMember(members, m.memberId, m.name);
                      if (person) openMember(person);
                    }}
                  >
                    <DeepDiveAvatar
                      runId={m.runId}
                      author={resolveMember(members, m.memberId, m.name)}
                      name={m.name}
                      initials={m.initials}
                      size={36}
                    />
                  </button>
                  <div className="message-body">
                    <div className="message-meta">
                      <button
                        className="member-name-button"
                        onClick={() => {
                          const member = resolveMember(
                            members,
                            m.memberId,
                            m.name,
                          );
                          if (member) openMember(member);
                        }}
                      >
                        {members.find((person) => person.id === m.memberId)
                          ?.name ?? m.name}
                      </button>
                      <MemberClearance
                        member={resolveMember(members, m.memberId, m.name)}
                      />
                      <time>{m.time}</time>
                    </div>
                    <div className="message-text">
                      {typeof m.body === 'string'
                        ? messageText(m.body)
                        : m.body}
                    </div>
                    {m.requestState === 'pending' && (
                      <output className="message-request-state">
                        Responding…{' '}
                        {stop && (
                          <button onClick={() => stop(m.id)}>Stop</button>
                        )}
                      </output>
                    )}
                    {m.requestState === 'error' && (
                      <div
                        className="message-request-state message-request-error"
                        role="alert"
                      >
                        {m.error}
                        <button onClick={() => retry(m)}>Retry</button>
                      </div>
                    )}
                    {m.attachment && (
                      <button
                        className="chat-attachment"
                        onClick={() => navigate('data')}
                      >
                        <FileText size={22} />
                        <span>
                          <strong>{m.attachment.name}</strong>
                          <small>{m.attachment.detail}</small>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    )}
                    {messageApproval(m) && (
                      <div className="approval-preview">
                        <button
                          className="btn btn-secondary"
                          onClick={() => reviewDraft(messageApproval(m)?.id)}
                        >
                          <FileText size={14} /> Review action
                        </button>
                        <span className="badge">{messageApproval(m)?.status}</span>
                      </div>
                    )}
                    <div className="message-reactions">
                      {(m.reactions || 0) + (reactionCounts[m.id] || 0) > 0 && (
                        <button
                          className="reaction"
                          onClick={() => react(m.id)}
                        >
                          <ThumbsUp size={12} />{' '}
                          {(m.reactions || 0) + (reactionCounts[m.id] || 0)}
                        </button>
                      )}
                      {(replies[m.id]?.length || 0) > 0 && (
                        <button
                          className="reply-action"
                          onClick={() => setThread(m)}
                        >
                          <MessageCircle size={13} />
                          {replies[m.id]?.length || 0}{' '}
                          {(replies[m.id]?.length || 0) === 1
                            ? 'reply'
                            : 'replies'}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="message-tools">
                    <button
                      className="icon-btn"
                      aria-label="React"
                      onClick={() => react(m.id)}
                    >
                      <Smile size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Reply"
                      onClick={() => setThread(m)}
                    >
                      <MessageCircle size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="composer-wrap">
              <ChatDeepDiveActivity room={room} />
              <div className="composer">
                <LiveComposer
                  ref={composerRef}
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  members={members}
                  onMention={onMention}
                  placeholder={`Message ${dm ? '@' : '#'}${channel}`}
                />
                <div className="composer-bottom">
                  <div>
                    <button
                      className="icon-btn"
                      aria-label="Message actions"
                      aria-expanded={composerMenu}
                      onClick={() => setComposerMenu(!composerMenu)}
                    >
                      <Plus size={16} />
                    </button>
                    {composerMenu && (
                      <div className="composer-menu">
                        <button
                          onClick={() => {
                            navigate('data');
                            setComposerMenu(false);
                          }}
                        >
                          <Paperclip size={14} /> Browse files
                        </button>
                        <button
                          onClick={() => {
                            insertText('`code`');
                            setComposerMenu(false);
                          }}
                        >
                          <Code size={14} /> Insert code
                        </button>
                      </div>
                    )}
                    <button
                      className="icon-btn"
                      aria-label="Mention teammate"
                      onClick={() => insertText('@')}
                    >
                      <AtSign size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Bold text"
                      onClick={formatSelection}
                    >
                      <Bold size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Attach file"
                      onClick={() => navigate('data')}
                    >
                      <Paperclip size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Add emoji"
                      onClick={() => setDraft(`${draft} 🙂`)}
                    >
                      <Smile size={16} />
                    </button>
                    <span className="composer-divider" />
                    <ChatDeepDiveControl mode={runMode} onChange={setRunMode} />
                  </div>
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={!draft.trim()}
                    onClick={send}
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            </div>
          </div>
          {contextOpen && (
            <aside className="context-panel">
              <div className="context-heading">
                <h2>Room context</h2>
                <button
                  className="icon-btn"
                  aria-label="Context info"
                  onClick={() => notify('Room details')}
                >
                  <Info size={15} />
                </button>
              </div>
              <div className="context-section">
                <div className="context-label">
                  <span>AGENTS IN THIS ROOM</span>
                  <button onClick={() => navigate('agents')}>View all</button>
                </div>
                {roomAgents.map(agent => <button
                  className="context-agent"
                  key={agent.id}
                  onClick={() => openMember(agent)}
                >
                  <MemberAvatar member={agent} size={32} />
                  <span>
                    <strong>{agent.name} <span className={`tiny-route ${agent.kind === 'agent' ? agent.runtime : 'local'}`}>{agent.kind === 'agent' ? agent.runtime.toUpperCase() : ''}</span></strong>
                    <small>{agent.kind === 'agent' ? agent.model : ''}</small>
                  </span>
                </button>)}
                <button
                  className="add-agent-link"
                  onClick={() => navigate('agents')}
                >
                  <Plus size={14} /> Invite an agent
                </button>
              </div>
              <div className="context-section">
                <div className="context-label">
                  <span>SHARED FILES</span>
                  <button onClick={() => setTab('files')}>See all</button>
                </div>
                {roomDocuments.map(document => (
                  <button className="context-document" key={document.id} onClick={() => setTab('files')}>
                    <span className="document-icon"><FileText size={15} /></span>
                    <span><strong>{document.name}</strong><small><Users size={10} /> {document.collection}</small></span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              <div className="context-note">
                <ShieldCheck size={14} />
                <p>
                  Agents can prepare drafts here. People approve external
                  actions.
                </p>
              </div>
            </aside>
          )}
        </div>
      ) : tab === 'canvas' ? (
        <div className="conversation-scroll canvas-panel">
          <h2>{channel} notes</h2>
          <textarea
            className="canvas-editor"
            value={canvas}
            onChange={(e) => setCanvas(e.target.value)}
            aria-label="Edit shared canvas"
          />
        </div>
      ) : (
        <div className="conversation-scroll">
          <div className="card shared-file">
            <div className="card-header">
              <h2>
                Files shared in {dm ? '' : '#'}
                {channel}
              </h2>
              <button
                className="btn btn-secondary"
                onClick={() => navigate('data')}
              >
                <Database size={15} /> Browse Data
              </button>
            </div>
            {roomDocuments.map(document => (
              <button className="list-row" key={document.id} onClick={() => navigate('data')}>
                <FileText size={17} />
                <span><strong>{document.name}</strong><small className="muted">{document.collection} · {document.status}</small></span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function View({
  preferences,
  setPreferences,
  reviewDraft,
  openRoom,
  view,
  navigate,
  notify,
}: {
  preferences: boolean[];
  setPreferences: (value: boolean[]) => void;
  reviewDraft: (id?: string) => void;
  openRoom: (name: string, threadId?: string) => void;
  view: View;
  navigate: (view: string) => void;
  notify: (message: string) => void;
}) {
  const hidden = (target: View) => ({
    className: 'view-content',
    style: {
      display: view === target ? 'block' : 'none',
      minHeight: 0,
      overflowY: 'auto',
      flex: 1,
    } as CSSProperties,
    'aria-hidden': view !== target,
  });
  return (
    <>
      <div {...hidden('inbox')}>
        <InboxView reviewDraft={reviewDraft} openRoom={openRoom} />
      </div>
      <div {...hidden('data')}>
        <DataView onNotify={notify} />
      </div>
      <div {...hidden('compute')}>
        <ComputeView onNotify={notify} />
      </div>
      <div {...hidden('huddles')}>
        <HuddlesView />
      </div>
      <div {...hidden('settings')}>
        <SettingsView
          navigate={navigate}
          preferences={preferences}
          setPreferences={setPreferences}
        />
      </div>
    </>
  );
}
export default Workspace;
