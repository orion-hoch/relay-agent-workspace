'use client';
import Image from 'next/image';
import { SeaweedIcon } from '@/components/SeaweedIcon';

import { DEFAULT_LAYERS } from '@/lib/privacy-layers';
import { EmojiPicker } from './components/EmojiPicker';
import { ConversationMenu } from './components/ConversationMenu';
import { ChannelBrowser } from './components/ChannelBrowser';
import { RenameChannel } from './components/RenameChannel';
import { ChannelDialog } from './components/ChannelDialog';
import { agentCanAccessChannel } from '@/lib/buzz/context-scope';
import { ChatDeepDiveActivity, ChatDeepDiveControl, type ChatMode } from './components/ChatDeepDiveControl';
import { DeepDiveAvatar } from '@/components/DeepDiveAvatar';
import type { MessageRecord } from '@/lib/buzz/types';
import { buzz, call, useBuzz } from '@/lib/buzz/store';
import { MessageBody } from './components/MessageBody';
import { HistoryButton } from './components/HistoryButton';
import { CommandPanel, type CommandRequest } from './components/CommandPanel';
import { Quickstart } from './components/Quickstart';
import { ModelPanel, openModels } from './components/ModelPanel';
import { commands, parseCommand } from '@/lib/commands';
import { useWorkspaceSetting } from '@/lib/buzz/use-workspace-setting';
import {
  setAgentActivity,
  setAgentAvailability,
} from '@/components/AgentAvatar';
import { ChatTaskOptions, ChatTaskMessage, ChatTaskActivity, useChatTasks, type TaskDraft } from './components/ChatTasks';
import { taskActive, type AgentTask } from '@/lib/task-types';
import { TerminalView, terminalAction } from './components/TerminalView';
import { SettingsView, type Preferences } from './components/SettingsView';
import { InboxView } from './components/InboxView';
import { isAdmin } from '@/lib/team-types';
import { clockTime, escapeRegExp } from '@/lib/format';
import {
  useWorkspaceMembers,
  type WorkspaceMember,
} from '@/lib/workspace-members';
import { LiveComposer, type ComposerHandle } from './LiveComposer';
import { MemberAvatar } from '@/components/MemberAvatar';
import { useAgentHomes } from '@/lib/agent-homes';
import { ChatHeader } from '@/components/buzz/ChatHeader';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, CSSProperties, SetStateAction } from 'react';
import {
  Archive,
  AtSign,
  Bold,
  Code,
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  Hash,
  Inbox,
  MessageCircle,
  PanelRight,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  Users,
  X,
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataView, openGoogleDrive, openDataFile, openFileUpload } from './components/DataView';
import { AgentsView } from './components/AgentsView';

type View =
  | 'chat'
  | 'inbox'
  | 'agents'
  | 'data'
  | 'compute'
  | 'settings'
  | 'terminal';
const viewFor = (next: string) => (next === 'agents' ? 'compute' : next) as View;
type Message = {
  id: string;
  runId?: string;
  name: string;
  initials: string;
  tone: string;
  time: string;
  body: string;
  agent?: 'local' | 'cloud';
  createdAt: string;
  memberId?: string;
  requestState?: 'pending' | 'error' | 'complete';
  error?: string;
  attachment?: { name: string; detail: string; documentId?: string };
  reactions?: Record<string, string[]>;
};
function resolveMember(
  members: readonly WorkspaceMember[],
  id?: string,
  name?: string,
) {
  return id
    ? members.find((member) => member.id === id)
    : members.find((member) => member.name === name);
}
function toMessage(record: MessageRecord, members: readonly WorkspaceMember[]): Message {
  const member = resolveMember(members, record.memberId, record.name);
  return {
    id: record.id,
    runId: record.runId ?? undefined,
    name: member?.name ?? record.name,
    memberId: record.memberId,
    initials: member?.initials ?? record.name.slice(0, 2),
    tone: member?.tone ?? 'mint',
    body: record.body,
    time: clockTime(record.createdAt),
    agent: member?.kind === 'agent' ? member.runtime : undefined,
    createdAt: record.createdAt,
    requestState: record.state ?? undefined,
    error: record.error ?? undefined,
    attachment: record.attachment ?? undefined,
    reactions: record.reactions,
  };
}
function MemberClearance({ member }: { member?: WorkspaceMember }) {
  return member?.kind === 'agent' ? (
    <span className="member-clearance">
      ({member.accessLevel.toLowerCase()})
    </span>
  ) : null;
}
function dayLabel(iso?: string) {
  if (!iso) return '';
  const date = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
// Member names may contain spaces, so mention matching is built from the roster (longest first).
function mentionPattern(members: readonly WorkspaceMember[]) {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(\\*\\*[^*]+\\*\\*|@(?:${[...names, '[\\w-]+'].join('|')}))`);
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
  const [memberProfile, setMemberProfile] = useState<WorkspaceMember | null>(
    null,
  );

  const [view, setView] = useState<View>('chat');
  const [channel, setChannel] = useState('');
  const [dm, setDm] = useState<string | null>(null);
  const [runModes, setRunModes] = useState<Record<string, ChatMode>>({});
  const {
    messages: sharedMessages,
    channels: sharedChannels,
    channelDetails,
    hiddenRooms=[],
    privacyLayers=DEFAULT_LAYERS,
    members: sharedMembers,
    runs,
    approvals,
    loaded: sharedLoaded,
    user,
    uiState,
  } = useBuzz();
  const workspaceName = typeof uiState.workspaceName === 'string' ? uiState.workspaceName : 'My workspace';
  const currentUserId = user?.id || '';
  const {tasks,loaded:tasksLoaded,reload:reloadTasks}=useChatTasks(currentUserId,view==='chat'?channel:'');
  const [taskDrafts,setTaskDrafts]=useState<Record<string,TaskDraft>>({});
  const [taskSending,setTaskSending]=useState<Record<string,boolean>>({});
  const taskSendingRef=useRef(new Set<string>());
  const taskAgents=members.filter(member=>member.kind==='agent' && !member.paused && (dm ? member.id===dm : sharedMembers.some(record=>record.id===member.id && agentCanAccessChannel(record,channelDetails?.find(item=>item.name===channel)||{name:channel,level:'Internal',agents:null},privacyLayers))));
  const taskOptions=(room:string)=>runModes[room]==='task' ? <ChatTaskOptions key={room} value={taskDrafts[room] || {}} onChange={value=>setTaskDrafts(all=>({...all,[room]:value}))} agents={taskAgents} disabled={!!taskSending[room]}/> : null;
  const mention = useMemo(() => mentionPattern(members), [members]);
  const channels = sharedChannels;
  const channelLabel=(room:string)=>channelDetails?.find(item=>item.name===room)?.displayName || room;
  useEffect(() => {
    if (!channel && channels.some(name=>!hiddenRooms.includes(name))) { const timer = setTimeout(() => setChannel(channels.find(name=>!hiddenRooms.includes(name))!), 0); return () => clearTimeout(timer); }
  }, [channel, channels,hiddenRooms]);
  const messagesByRoom = useMemo(() => {
    const rooms: Record<string, Message[]> = {};
    for (const record of sharedMessages) (rooms[record.room] ??= []).push(toMessage(record, members));
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[channel] ?? '';
  const writeDraft = (room: string, update: SetStateAction<string>) => setDrafts(all => {
    const next = typeof update === 'function' ? update(all[room] ?? '') : update;
    const copy = { ...all }; if (next) copy[room] = next; else delete copy[room]; return copy;
  });
  const setDraft = (update: SetStateAction<string>) => writeDraft(channel, update);
  const [commandRequest, setCommandRequest] = useState<CommandRequest | null>(null);
  const [quickstartOpen, setQuickstartOpen] = useState(false);
  const closeQuickstart = () => {
    setQuickstartOpen(false);
    try { localStorage.setItem('shoal-quickstart:' + currentUserId, 'seen'); } catch { /* Optional preference. */ }
  };

  const [toast, setToast] = useState('');
  useEffect(() => {
    const notice = (event: Event) => setToast(String((event as CustomEvent).detail));
    window.addEventListener('shoal:notice', notice);
    return () => window.removeEventListener('shoal:notice', notice);
  }, []);
  const homes = useAgentHomes();
  useEffect(() => {
    const tick = () => void buzz.runtime().catch(() => {});
    tick();
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  }, []);
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
          member.avatar,
        );
    });
  }, [homes, members]);
  const [threadSnapshot, setThread] = useState<Message | null>(null);
  const thread = threadSnapshot
    ? (Object.values(messagesByRoom)
        .flat()
        .find((message) => message.id === threadSnapshot.id) ?? threadSnapshot)
    : null;
  const [tab, setTab] = useState('messages');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [newChannel, setNewChannel] = useState(false);
  const [browsingChannels,setBrowsingChannels]=useState(false),[renamingChannel,setRenamingChannel]=useState<string|null>(null);
  const [editingChannel,setEditingChannel]=useState<string|null>(null);
  const [canvases, setCanvases] = useWorkspaceSetting<Record<string, string>>('canvases', {});
  const canvas = canvases[channel] ?? '';
  const setCanvas = (value: string) =>
    channel.startsWith('dm:') ? notify('Private conversation canvases are not available in this release.') : setCanvases((all) => ({ ...all, [channel]: value }));
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const activeApproval =
    approvals.find(item => item.id === selectedApprovalId) ?? approvals.find((item) => item.status === 'Pending') ?? approvals[0];
  const approval = activeApproval?.status ?? 'No pending review';
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalClock, setApprovalClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setApprovalClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const approvalActionable = !!activeApproval && activeApproval.status === 'Pending' && !activeApproval.receipt
    && (!activeApproval.expiresAt || Date.parse(activeApproval.expiresAt) > approvalClock);
  const [preferences, setPreferences] = useState<Preferences>({ compact: false, shortcuts: true });
  const [inboxRead, setInboxRead] = useState<string[]>([]);
  // ponytail: read markers live per device in localStorage; move to a server-side read_markers table if cross-device unread matters.
  const [lastRead, setLastRead] = useState<Record<string, string>>({});
  const [hydratedAt, setHydratedAt] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!currentUserId || !sharedLoaded || hydrated) return;
    const timeout = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem('shoal-workspace:'+currentUserId);
        if (saved) {
          const data = JSON.parse(saved) as { preferences?: Preferences; runModes?:Record<string,ChatMode>; taskDrafts?:Record<string,TaskDraft>; draft?: string; drafts?: Record<string, string>; lastRead?: Record<string, string>; inboxRead?: string[]; location?: {view?:string;channel?:string;tab?:string;threadId?:string} };
          if (data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences)) setPreferences({ compact: !!data.preferences.compact, shortcuts: data.preferences.shortcuts !== false });
          if (Array.isArray(data.inboxRead)) setInboxRead(data.inboxRead.filter((id): id is string => typeof id === 'string'));
          if (data.drafts && typeof data.drafts === 'object' && !Array.isArray(data.drafts)) setDrafts(Object.fromEntries(Object.entries(data.drafts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
          else if (typeof data.draft === 'string') setDrafts({ [channels[0] || 'general']: data.draft });
          if(data.runModes)setRunModes(Object.fromEntries(Object.entries(data.runModes).filter(([,mode])=>['quick','deep','task'].includes(mode))));
          if(data.taskDrafts)setTaskDrafts(Object.fromEntries(Object.entries(data.taskDrafts).map(([room,value])=>[room,{...value,repositoryToken:undefined}])));
          if (data.lastRead && typeof data.lastRead === 'object') setLastRead(data.lastRead);
          const location=data.location;
          if(location){
            if(['chat','inbox','agents','data','compute','settings','terminal'].includes(location.view || ''))setView(viewFor(location.view!));
            const room=location.channel || '';
            const peer=room.startsWith('dm:') ? members.find(member=>member.id===room.slice(3)) : undefined;
            if(peer || channels.includes(room)){setChannel(room);setDm(peer?.id || null);}
            if(['messages','canvas','files'].includes(location.tab || ''))setTab(location.tab!);
            const parent=sharedMessages.find(message=>message.id===location.threadId && message.room===room);
            if(parent)setThread(toMessage(parent,members));
          }
        }
      } catch {
        /* Preferences are optional if storage is unavailable. */
      }
      try { if (!localStorage.getItem('shoal-quickstart:' + currentUserId) && !members.some(member => member.kind === 'agent')) setQuickstartOpen(true); } catch { /* Optional onboarding preference. */ }
      setHydratedAt(new Date().toISOString());
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [currentUserId, sharedLoaded, sharedMessages, hydrated, channels, members]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        'shoal-workspace:'+currentUserId,
        JSON.stringify({ preferences, drafts, runModes, taskDrafts:Object.fromEntries(Object.entries(taskDrafts).map(([room,value])=>[room,{...value,repositoryToken:undefined}])), lastRead, inboxRead, location:{view,channel,tab,threadId:threadSnapshot?.id} }),
      );
    } catch {
      /* Session state remains usable if browser storage is full. */
    }
  }, [hydrated, preferences, drafts, lastRead, inboxRead, currentUserId,view,channel,tab,threadSnapshot,runModes,taskDrafts]);
  const latestInRoom = (room: string) => messagesByRoom[room]?.at(-1)?.createdAt ?? '';
  useEffect(() => {
    if (!hydrated || view !== 'chat' || !channel) return;
    const rooms = [...(tab === 'messages' ? [channel] : []), ...(threadSnapshot ? [`thread:${threadSnapshot.id}`] : [])];
    const markVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const stamp = new Date().toISOString();
      setLastRead(all => {
        const next = {...all};
        for (const room of rooms) {
          const latest = latestInRoom(room);
          if (latest) next[room] = [all[room] || '', stamp, latest, ...runs.filter(run => run.room === room).map(run => run.endedAt || '')].sort().at(-1)!;
        }
        return next;
      });
    };
    const timer = setTimeout(markVisible, 0);
    document.addEventListener('visibilitychange', markVisible);
    window.addEventListener('focus', markVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', markVisible); window.removeEventListener('focus', markVisible); };
  }, [hydrated, view, channel, tab, threadSnapshot?.id, messagesByRoom, runs]); // eslint-disable-line react-hooks/exhaustive-deps
  const unreadCount = (room: string) => {
    if (!hydrated || (view === 'chat' && room === channel)) return 0;
    const since = lastRead[room] ?? hydratedAt;
    return (messagesByRoom[room] ?? []).filter(m => m.createdAt > since && m.memberId !== currentUserId).length;
  };
  const currentRef = useRef({ channel, view });
  useEffect(() => {
    currentRef.current = { channel, view };
  }, [channel, view]);
  const threadRoom = thread ? `thread:${thread.id}` : '';
  const threadTask=tasks.find(task=>task.room===threadRoom);
  const threadReply = drafts[threadRoom] ?? '';
  const setThreadReply = (update: SetStateAction<string>) => writeDraft(threadRoom, update);
  const threadComposerRef = useRef<ComposerHandle>(null);
  const [panelWidth, setPanelWidth] = useState(390);
  const panelRef = useRef<HTMLElement>(null);
  const threadMessages = thread
    ? (messagesByRoom[`thread:${thread.id}`] ?? [])
    : [];
  const openThread = (message: Message) => {
    setMemberProfile(null);
    setThread(message);
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
        if (!preferences.shortcuts) return;
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
      'settings',
      'terminal',
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
              setView(viewFor(next));
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
  }, [workspaceName]);
  const notify = (message: string) => setToast(message);
  const navigate = (next: string) => setView(viewFor(next));
  const [results, setResults] = useState<(Message & { room: string; conversation: string; parent: MessageRecord | null })[]>([]);
  useEffect(() => {
    if (!searchOpen) return;
    const q = search.trim();
    if (!q) return;
    let live = true;
    const timer = setTimeout(() => {
      buzz.search(q).then(found => { if (live) setResults(found.map(record => ({ ...toMessage(record, members), room: record.room, conversation: record.conversation, parent: record.parent }))); }).catch(() => { if (live) setResults([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search, searchOpen, members]);
  async function hideRoom(room:string){
    try{await buzz.setConversationHidden(room,true);if(channel===room){const next=channels.find(name=>name!==room&&!hiddenRooms.includes(name));if(next)openRoom(next);else{setChannel('');setDm(null);setView('inbox');}}}
    catch(error){notify(error instanceof Error?error.message:'Could not close conversation.');}
  }
  const markRead=(room:string)=>setLastRead(all=>({...all,[room]:latestInRoom(room)||new Date().toISOString()}));
  function openRoom(name: string) {
    const member = members.find(
      (person) => person.id === name || person.name === name,
    );
    const room = member ? `dm:${member.id}` : name;
    if(hiddenRooms.includes(room))void buzz.setConversationHidden(room,false).catch(error=>notify(error.message));
    setThread(null);
    setMemberProfile(null);
    setChannel(room);
    setDm(member?.id ?? null);

    setTab('messages');
    setView('chat');
  }
  function retryMessage(message: Message) {
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
  function executeCommand(text: string, room: string, clear: () => void) {
    const parsed = parseCommand(text);
    if (!parsed) return false;
    const { name, args } = parsed;
    if (name === 'model') {
      if (args.toLowerCase() === 'connect') { navigate('compute'); openModels(); }
      else navigate('compute');
    } else if (name === 'help') setCommandRequest(current=>({id:(current?.id??0)+1,kind:'help',args}));
    else if (['connect', 'integrations'].includes(name)) { navigate('compute'); openModels(); }
    else if (name === 'googledrive') { navigate('data'); openGoogleDrive(args); }
    else if (name === 'task' || name === 'goal') {
      setRunModes(all=>({...all,[room]:'task'}));writeDraft(room,args);return true;
    }
    else if (name === 'quickstart') setQuickstartOpen(true);
    else if (name === 'run') {
      if (!args) { notify('Usage: /run <shell command>. Example: /run pwd'); return true; }
      void terminalAction({ command: args, requestId: crypto.randomUUID() }).then(() => { clear(); navigate('terminal'); }).catch(error => notify(error.message));
      return true;
    } else if (name === 'terminal') navigate('terminal');
    else if (name === 'models') navigate('compute');
    else if (name === 'team') navigate('settings');
    else if (name === 'search') { setSearch(args); setSearchOpen(true); }
    else if (name === 'stop') {
      const run = [...runs].reverse().find(run => run.room === room && ['queued', 'preparing', 'running', 'awaiting'].includes(run.status));
      if (run) void buzz.cancelRun(run.id).catch(error => notify(error.message)); else notify('No active run in this conversation.');
    } else { notify(`Unknown command /${name}. Open /help to see commands and examples.`); setCommandRequest(current=>({id:(current?.id??0)+1,kind:'help',args:''})); return true; }
    clear(); return true;
  }
  async function sendToRoom(room:string) {
    const text=(drafts[room] || '').trim();
    if(!text || !room || taskSendingRef.current.has(room))return;
    if(executeCommand(text,room,()=>writeDraft(room,'')))return;
    if(!sharedLoaded || !tasksLoaded)return notify('The shared workspace is still connecting. Try again shortly.');
    const existing=tasks.find(task=>task.room===room);
    const mode=runModes[room] ?? 'quick';
    if(existing || mode==='task') {
      if(taskActive(existing))return notify('Stop the current task before sending another instruction.');
      const options=taskDrafts[room] || {};
      const agentId=existing?.agentId || options.agentId || (taskAgents.length===1?taskAgents[0].id:'');
      if(!agentId)return notify('Choose an agent for this task.');
      taskSendingRef.current.add(room);setTaskSending(all=>({...all,[room]:true}));
      try {
        const data=await call<{task:AgentTask}>('/api/tasks',{method:'POST',body:JSON.stringify(existing ? {action:'continue',id:existing.id,instruction:text} : {...options,action:'create',agentId,room,goal:text})});
        writeDraft(room,value=>value.trim()===text?'':value);
        setTaskDrafts(all=>({...all,[room]:{}}));setRunModes(all=>({...all,[room]:'quick'}));
        await reloadTasks();
        if(!room.startsWith('thread:') && currentRef.current.channel===room && currentRef.current.view==='chat') {
          const response=await call<{messages:MessageRecord[]}>(`/api/messages?room=${encodeURIComponent(room)}&id=${encodeURIComponent(data.task.room.slice(7))}`,{});
          if(response.messages[0])openThread(toMessage(response.messages[0],members));
        }
      }catch(error){notify(error instanceof Error?error.message:'Could not send task.');}
      finally{taskSendingRef.current.delete(room);setTaskSending(all=>({...all,[room]:false}));}
      return;
    }
    writeDraft(room,'');
    void buzz.sendMessage(room,text,crypto.randomUUID(),mode).catch((error:unknown)=>{
      writeDraft(room,value=>value || text);
      notify(error instanceof Error?error.message:'Message not sent. Try again.');
    });
  }
  const send=()=>void sendToRoom(channel);
  const sendThread=()=>void sendToRoom(threadRoom);
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
      className={`relay-shell ${preferences.compact ? 'compact' : ''}`}
    >
      {preferences.compact && (
        <style>{`.relay-shell.compact .message-row{padding-top:6px;padding-bottom:6px}.relay-shell.compact .message-body p{line-height:1.35}.relay-shell.compact .avatar{width:30px;height:30px}`}</style>
      )}
      <ModelPanel />
      <CommandPanel request={commandRequest} onClose={() => setCommandRequest(null)} />
      <Quickstart open={quickstartOpen} onClose={closeQuickstart} onNavigate={navigate} onChat={id => { openRoom(id); writeDraft(`dm:${id}`, 'What can you help our team with?'); }} />
      <Sidebar className="relay-sidebar" collapsible="offcanvas">
        <SidebarHeader className="rail-header">
          <div className="brand">
            <Image className="brand-symbol" src="/shoal.svg" width={28} height={28} alt="" />
            Shoal<span className="brand-period">.</span>
            <span className="brand-version">PREVIEW</span>
          </div>
          <button
            className="workspace-switch"
            onClick={() => navigate('settings')}
            aria-label="Workspace settings"
          >
            <span className="workspace-avatar">{workspaceName.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{workspaceName}</strong>
              <small>Workspace</small>
            </span>
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
            {nav(<SeaweedIcon size={17} />, 'Habitats', 'compute')}
            {nav(<Code size={17} />, 'Terminal', 'terminal')}
          </SidebarMenu>
          <div className="rail-section-label">
            <button className="channel-browser-trigger" aria-label="Browse channels" onClick={()=>setBrowsingChannels(true)}>CHANNELS</button>
            {user&&isAdmin(user)&&<button
              className="icon-btn"
              aria-label="New channel"
              onClick={() => setNewChannel(true)}
            >
              <Plus size={15} />
            </button>}
          </div>
          <SidebarMenu>
            {channels.filter(name=>!hiddenRooms.includes(name)).map((name) => (
              <SidebarMenuItem key={name}>
                <ConversationMenu items={[{label:'Channel settings',onClick:()=>setEditingChannel(name)},...(user&&isAdmin(user)?[{label:'Rename channel',onClick:()=>setRenamingChannel(name)}]:[]),{label:'Mark as read',onClick:()=>markRead(name)},{label:'Leave channel',onClick:()=>void hideRoom(name),danger:true}]}><SidebarMenuButton
                  aria-label={channelLabel(name)}
                  className="rail-link"
                  data-active={view === 'chat' && channel === name}
                  onClick={() => {
                    openRoom(name);
                  }}
                >
                  <Hash size={16} />
                  <span data-unread={unreadCount(name) > 0 || undefined}>{channelLabel(name)}</span>
                  {unreadCount(name) > 0 && <span className="nav-count">{unreadCount(name)}</span>}
                </SidebarMenuButton></ConversationMenu>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="rail-section-label">
            <span>WORKSPACE</span>
          </div>
          <SidebarMenu>
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
              .filter((member) => member.id !== currentUserId && !hiddenRooms.includes(`dm:${member.id}`))
              .map((p) => (
                <SidebarMenuItem key={p.id}>
                  <ConversationMenu items={[{label:'View profile',onClick:()=>{openRoom(p.id);openProfile(p);}},{label:'Mark as read',onClick:()=>markRead(`dm:${p.id}`)},{label:'Close conversation',onClick:()=>void hideRoom(`dm:${p.id}`)}]}><SidebarMenuButton
                    aria-label={p.name}
                    className="rail-link"
                    data-active={view === 'chat' && dm === p.id}
                    onClick={() => openRoom(p.id)}
                  >
                    <MemberAvatar member={p} size={24} />
                    <span data-unread={unreadCount(`dm:${p.id}`) > 0 || undefined}>{p.name}</span>
                    {unreadCount(`dm:${p.id}`) > 0 && <span className="nav-count">{unreadCount(`dm:${p.id}`)}</span>}
                  </SidebarMenuButton></ConversationMenu>
                </SidebarMenuItem>
              ))}
          </SidebarMenu>
        </NavigationContent>

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
                ? `${dm ? '@' : '#'} ${dm ? members.find(member=>member.id===dm)?.name || channel : channelLabel(channel)}`
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
              {approvals.some((item) => item.status === 'Pending') && <span className="notification-count">{approvals.filter(item => item.status === 'Pending').length}</span>}
            </button>

          </div>
        </header>
        <div
          style={{ display: view === 'chat' ? 'contents' : 'none' }}
          aria-hidden={view !== 'chat'}
        >
          <Chat
            room={channel}
            tasks={tasks}
            taskOptions={taskOptions(channel)}
            taskSending={!!taskSending[channel]}
            taskAvailable={user?.role!=='viewer' && taskAgents.length>0}
            runMode={runModes[channel] ?? 'quick'}
            setRunMode={mode => setRunModes(current => ({...current, [channel]: mode}))}
            channel={
              members.find((member) => member.id === dm)?.name ?? channelLabel(channel)
            }
            members={members}
            currentUserId={currentUserId}
            mention={mention}
            retry={retryMessage}
            stop={id => { const message = messages.find(message => message.id === id); if (message?.runId) void buzz.cancelRun(message.runId).catch(error => notify(error.message)); }}
            openMember={openProfile}
            dm={!!dm}
            recipient={members.find((member) => member.id === dm)}
            reviewDraft={(id) => { setSelectedApprovalId(id ?? null); setApprovalOpen(true); }}
            invite={() => setEditingChannel(channel)}
            replyCounts={Object.fromEntries(messages.map((message) => [message.id, messagesByRoom[`thread:${message.id}`]?.length ?? 0]))}
            tab={tab}
            setTab={setTab}
            messages={messages}
            draft={draft}
            setDraft={setDraft}
            send={send}
            setThread={openThread}
            canvas={canvas}
            setCanvas={setCanvas}
            notify={notify}
          />
        </div>
        <View
          view={view}
          notify={notify}
          preferences={preferences}
          setPreferences={setPreferences}
          inboxRead={inboxRead}
          lastRead={lastRead}
          setLastRead={setLastRead}
          setInboxRead={setInboxRead}
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
                        <strong>{thread.name}</strong>
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
                        <MessageBody text={thread.body} mention={mention} />
                      </div>
                    </div>
                  </div>
                  <HistoryButton room={`thread:${thread.id}`} firstId={threadMessages[0]?.id} />
                  <div className="thread-reply-divider">
                    {threadMessages.length} {threadMessages.length === 1 ? 'reply' : 'replies'}
                  </div>
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
                          <strong>{reply.name}</strong>
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
                          <MessageBody text={reply.body} mention={mention} />
                        </div>
                        {reply.requestState === 'pending' && (
                          <output className="message-request-state">
                            Responding{' '}
                          </output>
                        )}
                        {reply.requestState === 'error' && (
                          <div className="message-request-state" role="alert">
                            {reply.error}
                            <button
                              onClick={() => retryMessage(reply)}
                            >
                              Retry
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <>{threadTask ? <ChatTaskActivity key={threadTask.id} task={threadTask} onUpdated={reloadTasks}/> : <ChatDeepDiveActivity room={threadRoom}/>}</>
                <div className="thread-composer composer">
                  {!threadTask && taskOptions(threadRoom)}
                  <LiveComposer
                    ref={threadComposerRef}
                    value={threadReply}
                    onChange={setThreadReply}
                    onSend={sendThread}
                    members={members.filter(member=>member.kind!=='agent'||(dm ? member.id===dm : sharedMembers.some(record=>record.id===member.id && agentCanAccessChannel(record,channelDetails?.find(item=>item.name===channel)||{name:channel,level:'Internal',agents:null},privacyLayers))))}
                    currentUserId={currentUserId}
                    placeholder={threadTask ? "Continue this task" : runModes[threadRoom]==='task' ? "Describe the task" : "Reply in thread"}
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
                      <EmojiPicker label="Add emoji to reply" onSelect={emoji => threadComposerRef.current?.insertText(emoji)} focusAfterSelect={threadComposerRef} />
                      <>{threadTask ? <span className="chat-task-reply-label">Task reply</span> : <ChatDeepDiveControl mode={runModes[threadRoom] ?? 'quick'} onChange={mode => setRunModes(current => ({...current, [threadRoom]: mode}))} taskAvailable={user?.role!=='viewer' && taskAgents.length>0} disabled={!!taskSending[threadRoom]}/>}</>
                    </div>
                    <button
                      className="send-button"
                      disabled={!threadReply.trim() || !!taskSending[threadRoom] || taskActive(threadTask)}
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
                              ? memberProfile.device
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
              placeholder="Search messages"
              aria-label="Search messages"
            />
            <kbd>ESC</kbd>
          </div>
          <div className="search-results">
            {(!search.trim() || results.length === 0) && (
              <p className="search-empty">{search.trim() ? 'No messages found.' : 'Type to search messages.'}</p>
            )}
            {(search.trim() ? results : []).map((m) => (
              <button
                key={`${m.room}-${m.id}`}
                onClick={() => {
                  setSearchOpen(false);
                  openRoom(m.conversation.startsWith('dm:') ? m.conversation.slice(3) : m.conversation);
                  openThread(m.parent ? toMessage(m.parent, members) : m);
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
                    {m.name}: {m.body}
                  </strong>
                  <small>
                    {m.room.startsWith('dm:')
                      ? (members.find((person) => person.id === m.room.slice(3))
                          ?.name ?? 'Direct message')
                      : `#${channelLabel(m.conversation)}`}{' '}
                    / {m.time}
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
          {user && isAdmin(user) && <button className="btn btn-primary" onClick={()=>{setPeopleOpen(false);navigate('settings');}}>Invite people & manage team</button>}
          {members
            .filter((person) => person.id !== currentUserId)
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
                ? `${activeApproval.agent} / ${activeApproval.level}`
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
      {browsingChannels&&<ChannelBrowser onClose={()=>setBrowsingChannels(false)} onOpen={name=>{openRoom(name);setBrowsingChannels(false);}}/>}
      {renamingChannel&&<RenameChannel room={renamingChannel} onClose={()=>setRenamingChannel(null)}/>}
      {(newChannel||!!editingChannel)&&<ChannelDialog open={newChannel||!!editingChannel} channel={editingChannel||undefined} onClose={()=>{setNewChannel(false);setEditingChannel(null);}} onSaved={name=>{if(newChannel){openRoom(name);setView('chat');}notify(newChannel?'Channel created.':'Channel saved.');}}/>}
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
  tasks,
  taskOptions,
  taskSending,
  taskAvailable,
  members,
  currentUserId,
  mention,
  retry,
  stop,
  openMember,
  recipient,
  dm,
  reviewDraft,
  invite,
  replyCounts,
  channel,
  tab,
  setTab,
  messages,
  draft,
  setDraft,
  send,
  setThread,
  canvas,
  setCanvas,
  notify,
}: {
  room: string;
  runMode: ChatMode;
  setRunMode: (mode: ChatMode) => void;
  tasks: AgentTask[];
  taskOptions: ReactNode;
  taskSending: boolean;
  taskAvailable: boolean;
  recipient?: WorkspaceMember;
  members: readonly WorkspaceMember[];
  currentUserId: string;
  mention: RegExp;
  retry: (message: Message) => void;
  stop: (id: string) => void;
  openMember: (member: WorkspaceMember) => void;
  dm: boolean;
  reviewDraft: (id?: string) => void;
  invite: () => void;
  replyCounts: Record<string, number>;
  channel: string;
  tab: string;
  setTab: (value: string) => void;
  messages: Message[];
  draft: string;
  setDraft: (value: string) => void;
  send: () => void;
  setThread: (message: Message) => void;
  canvas: string;
  setCanvas: (value: string) => void;
  notify: (message: string) => void;
}) {
  const { documents, approvals,channelDetails=[],privacyLayers=DEFAULT_LAYERS,members:records } = useBuzz();
  const settings=channelDetails.find(item=>item.name===room);
  const roomAgents=members.filter(member=>member.kind==='agent' && (dm ? member.id===recipient?.id : records.some(record=>record.id===member.id && agentCanAccessChannel(record,settings||{name:room,level:'Internal',agents:null},privacyLayers))));
  const roomDocuments = documents.filter(document => document.sourceRoom===room);
  const messageApproval = (message: Message) => message.runId ? approvals.find(item => item.runId === message.runId && item.status === 'Pending'
    && !item.receipt && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())) : undefined;
  const [contextOpen, setContextOpen] = useState(false);
  const showContext = !dm && contextOpen;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const followingMessages = useRef(true);
  useEffect(()=>{if(dm&&tab==='canvas')setTab('messages');},[dm,tab,setTab]);
  useEffect(() => {
    const el = scrollRef.current;
    let saved=null;
    try {saved=sessionStorage.getItem(`shoal-scroll:${currentUserId}:${room}:${tab}`);}catch{}
    followingMessages.current = saved===null;
    if(el)el.scrollTop=saved===null ? el.scrollHeight : Number(saved);
    if(el)followingMessages.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;
  }, [room,tab,currentUserId]);
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
        onTitleClick={recipient ? () => openMember(recipient) : invite}
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
        actions={
          <div className="channel-actions">
            {!dm && (
              <div className="member-stack">
                {roomAgents.slice(0, 3).map((p) => (
                  <MemberAvatar key={p.id} member={p} size={24} />
                ))}
                <span className="member-number">{roomAgents.length}</span>
              </div>
            )}
            {!dm && (
              <button
                className="icon-btn"
                aria-label="Channel settings" title="Channel settings"
                onClick={invite}
              >
                <Settings size={20} />
              </button>
            )}
            {!dm && <button
              className="icon-btn"
              aria-label="Toggle room context"
              aria-expanded={showContext}
              onClick={() => setContextOpen(!contextOpen)}
            >
              <PanelRight size={22} />
            </button>}
          </div>
        }
      />
      {!dm&&settings?.topic&&<p className="channel-topic">{settings.topic}</p>}
      <div className="channel-tab-row">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="channel-tabs">
            <TabsTrigger value="messages">
              <MessageCircle size={14} />
              Messages
            </TabsTrigger>
            {!dm && <TabsTrigger value="canvas">
              <FileText size={14} />
              Canvas
            </TabsTrigger>}
            <TabsTrigger value="files">
              <Archive size={14} />
              Files
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === 'messages' ? (
        <div
          className={`conversation-layout ${showContext ? 'context-open' : ''}`}
          style={{
            gridTemplateColumns: showContext ? undefined : 'minmax(0, 1fr)',
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
                try {sessionStorage.setItem(`shoal-scroll:${currentUserId}:${room}:${tab}`,String(el.scrollTop));}catch{}
              }}
            >
              <HistoryButton room={room} firstId={messages[0]?.id} beforeLoad={() => {
                const element = scrollRef.current, height = element?.scrollHeight ?? 0, top = element?.scrollTop ?? 0;
                followingMessages.current = false;
                return () => { if (element) element.scrollTop = top + element.scrollHeight - height; };
              }} />
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
              {messages.map((m, index) => (
                <Fragment key={m.id}>
                {dayLabel(m.createdAt) !== dayLabel(messages[index - 1]?.createdAt) && <div className="date-divider">{dayLabel(m.createdAt)}</div>}
                <article
                  className={`message-row ${messages[index - 1]?.name === m.name && !m.runId ? 'message-grouped' : ''}`}
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
                        {m.name}
                      </button>
                      <MemberClearance
                        member={resolveMember(members, m.memberId, m.name)}
                      />
                      <time>{m.time}</time>
                    </div>
                    <div className="message-text">
                      <MessageBody text={m.body} mention={mention} />
                    </div>
                    {tasks.filter(task=>task.room===`thread:${m.id}`).map(task=><ChatTaskMessage key={task.id} task={task} onOpen={()=>setThread(m)}/>)}
                    {m.requestState === 'pending' && (
                      <output className="message-request-state">
                        Responding{' '}
                        <button onClick={() => stop(m.id)}>Stop</button>
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
                        onClick={() => m.attachment?.documentId ? openDataFile(m.attachment.documentId) : notify('This older attachment has no linked file.')}
                      >
                        <FileText size={22} />
                        <span>
                          <strong>{m.attachment.name}</strong>
                          <small>{documents.find(file=>file.id===m.attachment?.documentId)?.level || m.attachment.detail}</small>
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
                    {((replyCounts[m.id] || 0) > 0 || Object.keys(m.reactions ?? {}).length > 0) && (
                      <div className="message-reactions">
                        {Object.entries(m.reactions ?? {}).map(([emoji, ids]) => (
                          <button
                            key={emoji}
                            className="reaction"
                            data-mine={ids.includes(currentUserId) || undefined}
                            aria-label={`${emoji} ${ids.length}`}
                            onClick={() => buzz.react(m.id, emoji).catch(error => notify(error.message))}
                          >
                            {emoji} {ids.length}
                          </button>
                        ))}
                        {(replyCounts[m.id] || 0) > 0 && (
                          <button className="reply-action" onClick={() => setThread(m)}>
                            <MessageCircle size={13} />
                            {replyCounts[m.id]} {replyCounts[m.id] === 1 ? 'reply' : 'replies'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="message-tools">
                    <EmojiPicker label="Add reaction" onSelect={emoji => { void buzz.react(m.id, emoji).catch(error => notify(error.message)); }} />
                    <button
                      className="icon-btn"
                      aria-label="Reply"
                      onClick={() => setThread(m)}
                    >
                      <MessageCircle size={14} />
                    </button>
                  </div>
                </article>
                </Fragment>
              ))}
            </div>
            <div className="composer-wrap">
              {draft.startsWith('/') && <div className="slash-help" aria-label="Slash commands">{commands.filter(item => item.command.startsWith(draft.split(' ')[0].toLowerCase())).map(item => <button key={item.command} onClick={() => setDraft(item.command + ' ')}><code>{item.command}</code><span>{item.description}</span></button>)}</div>}

              <ChatDeepDiveActivity room={room} />
              <div className="composer">
                {taskOptions}
                <LiveComposer
                  ref={composerRef}
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  members={members.filter(member=>member.kind!=='agent'||roomAgents.some(agent=>agent.id===member.id))}
                  currentUserId={currentUserId}
                  placeholder={runMode==='task' ? 'Describe the task' : `Message ${dm ? '' : '#'}${channel}`}
                />
                <div className="composer-bottom">
                  <div>
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
                      onClick={() => openFileUpload(room)}
                    >
                      <Paperclip size={16} />
                    </button>
                    <EmojiPicker label="Add emoji" onSelect={insertText} focusAfterSelect={composerRef} />
                    <ChatDeepDiveControl mode={runMode} onChange={setRunMode} taskAvailable={taskAvailable} disabled={taskSending}/>
                  </div>
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={!draft.trim() || taskSending}
                    onClick={send}
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            </div>
          </div>
          {showContext && (
            <aside className="context-panel">
              <div className="context-heading">
                <h2>Room context</h2>
              </div>
              <div className="context-section">
                <div className="context-label">
                  <span>AGENTS IN THIS ROOM</span>
                  {!dm && <button onClick={invite}>Edit</button>}
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
                {!dm && <button className="add-agent-link" onClick={invite}><Plus size={14}/>Choose agents</button>}
              </div>
              <div className="context-section">
                <div className="context-label">
                  <span>SHARED FILES</span>
                  <button onClick={() => setTab('files')}>See all</button>
                </div>
                {roomDocuments.map(document => (
                  <button className="context-document" key={document.id} onClick={() => {openDataFile(document.id);}}>
                    <span className="document-icon"><FileText size={15} /></span>
                    <span><strong>{document.name}</strong><small><Users size={10} /> {document.level}</small></span>
                    <ChevronRight size={14} />
                  </button>
                ))}
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
        <div className="conversation-scroll"><DataView key={room} room={room} onNotify={notify}/></div>
      )}
    </section>
  );
}

function View({
  preferences,
  setPreferences,
  inboxRead,
  lastRead,
  setLastRead,
  setInboxRead,
  reviewDraft,
  openRoom,
  view,
  notify,
}: {
  preferences: Preferences;
  setPreferences: (value: Preferences) => void;
  inboxRead: string[];
  lastRead: Record<string,string>;
  setLastRead: (update: (current: Record<string,string>) => Record<string,string>) => void;
  setInboxRead: (update: (current: string[]) => string[]) => void;
  reviewDraft: (id?: string) => void;
  openRoom: (name: string, threadId?: string) => void;
  view: View;
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
      {view === 'terminal' && <div {...hidden('terminal')}><TerminalView /></div>}
      <div {...hidden('inbox')}>
        <InboxView reviewDraft={reviewDraft} openRoom={openRoom} read={inboxRead} setRead={setInboxRead} lastRead={lastRead} setLastRead={setLastRead} />
      </div>
      <div {...hidden('data')}>
        <DataView onNotify={notify} />
      </div>
      <div {...hidden('compute')}>
        <AgentsView onNotify={notify} />
      </div>
      <div {...hidden('settings')}>
        {view === 'settings' && <SettingsView preferences={preferences} setPreferences={setPreferences} />}
      </div>
    </>
  );
}
export default Workspace;
