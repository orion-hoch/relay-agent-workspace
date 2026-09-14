import { eventsAfter, loadState, mapDocument, mapMember, type BuzzEnv } from '../buzz/db';
import { dmMembers, resolveContextRoom } from '../buzz/context-scope';
import type {
  DocumentRecord,
  EventRecord,
  MemberRecord,
  RunRecord,
  WorkspaceState,
} from '../buzz/types';
import { isAdmin, type TeamUser } from '../team-types';

export function canUseAgent(user: TeamUser, agent: MemberRecord) {
  const grants = agent.data.allowedUsers;
  return (
    agent.kind === 'agent' &&
    !agent.data.paused &&
    (isAdmin(user) ||
      !Array.isArray(grants) ||
      grants.includes('*') ||
      grants.includes(user.id))
  );
}
export function canReadDocument(
  user: TeamUser,
  doc: Pick<DocumentRecord, 'owner' | 'readers'>,
) {
  return (
    isAdmin(user) ||
    doc.owner === user.id ||
    !!doc.readers?.some((id) => id === '*' || id === user.id)
  );
}
function canEditDocument(
  user: TeamUser,
  doc: Pick<DocumentRecord, 'owner'>,
) {
  return isAdmin(user) || doc.owner === user.id;
}
export function publicRoom(room: string, userId: string) {
  return room.startsWith('dm:')
    ? 'dm:' + dmMembers(room).find((id) => id !== userId)
    : room;
}
export function publicRun(run: RunRecord, userId: string) {
  return { ...run, room: run.room ? publicRoom(run.room, userId) : run.room };
}
export async function canonicalRoom(
  e: BuzzEnv,
  user: TeamUser,
  room: string,
  writing = true,
): Promise<string | null> {
  if (!room.startsWith('dm:'))
    return (await canReadRoom(e, user, room)) ? room : null;
  const ids = dmMembers(room);
  const peer =
    ids.length === 1
      ? ids[0]
      : ids.length === 2 && ids.includes(user.id)
        ? ids.find((id) => id !== user.id)
        : null;
  if (!peer || peer === user.id) return null;
  const row = await e.DB.prepare('SELECT * FROM members WHERE id=?')
    .bind(peer)
    .first<Record<string, unknown>>();
  if (!row) return null;
  if (writing && row.kind === 'agent' && !canUseAgent(user, mapMember(row))) return null;
  if (
    writing && row.kind === 'human' &&
    !(await e.DB.prepare('SELECT id FROM users WHERE id=? AND active=1')
      .bind(peer)
      .first())
  )
    return null;
  const pair = row.kind === 'agent' ? [user.id, peer] : [user.id, peer].sort();
  return 'dm:' + pair.join(':');
}
export async function canReadRoom(
  e: BuzzEnv,
  user: TeamUser,
  room: string | null,
): Promise<boolean> {
  if (!room) return true;
  const root = await resolveContextRoom(e, room).catch(() => null);
  if (!root) return false;
  if (root.startsWith('dm:')) return dmMembers(root).includes(user.id);
  return !!(await e.DB.prepare('SELECT name FROM channels WHERE name=?')
    .bind(root)
    .first());
}
export async function canReadRun(e: BuzzEnv, user: TeamUser, runId: string) {
  const run = await e.DB.prepare('SELECT room FROM runs WHERE id=?')
    .bind(runId)
    .first<{ room: string | null }>();
  return !!run && (await canReadRoom(e, user, run.room));
}
export async function visibleState(
  e: BuzzEnv,
  user: TeamUser,
): Promise<WorkspaceState> {
  const rooms = await readableRooms(e, user);
  const state = await loadState(e, rooms);
  const messages = state.messages.map(message => ({ ...message, room: publicRoom(message.room, user.id) }));
  const runs = state.runs.map(run => publicRun(run, user.id));
  const documents = state.documents.filter((doc) => canReadDocument(user, doc)).map(doc=>({...doc,sourceRoom:doc.sourceRoom && (!doc.sourceRoom.startsWith('dm:') || dmMembers(doc.sourceRoom).includes(user.id)) ? publicRoom(doc.sourceRoom,user.id) : null}));
  const approvals = state.approvals.filter((item) =>
    isAdmin(user)
      ? !item.runId || runs.some((run) => run.id === item.runId)
      : !!item.runId && runs.some((run) => run.id === item.runId),
  );
  const preferences=await e.DB.prepare('SELECT p.room,p.hidden_at,(SELECT MAX(m.created_at) FROM messages m WHERE m.room=p.room) AS latest FROM conversation_preferences p WHERE p.user_id=?').bind(user.id).all<{room:string;hidden_at:string;latest:string|null}>();
  const hiddenRooms=preferences.results.filter(pref=>!pref.room.startsWith('dm:') || !pref.latest || pref.latest<=pref.hidden_at).map(pref=>publicRoom(pref.room,user.id));
  const uiState = { ...state.uiState };
  // A single shared canvas object cannot isolate private conversations. Team canvases are channel-only.
  if (uiState.canvases && typeof uiState.canvases === 'object')
    uiState.canvases = Object.fromEntries(
      Object.entries(uiState.canvases).filter(([key]) =>
        state.channels.includes(key),
      ),
    );
  return {
    ...state,
    hiddenRooms,
    historyRooms: rooms.map(room => publicRoom(room, user.id)),
    user,
    uiState,
    messages,
    runs,
    documents,
    approvals,
    members: state.members.filter(
      (member) => member.kind === 'human' || isAdmin(user) || canUseAgent(user, member),
    ),
    collections: [...new Set(documents.map((doc) => doc.collection))],
  };
}
export async function visibleEvents(
  e: BuzzEnv,
  user: TeamUser,
  after: number,
): Promise<{ events: EventRecord[]; cursor: number; reset: boolean }> {
  const rows = await eventsAfter(e, after);
  const events: EventRecord[] = [];
  let reset = false;
  for (const event of rows) {
    const p = event.payload;
    if(event.type==='conversation.preference'){
      if(p.userId===user.id)events.push({...event,payload:{...p,room:publicRoom(String(p.room),user.id)}});
      continue;
    }
    if (
      event.type === 'team.changed' ||
      event.type === 'message.reactions' ||
      event.type === 'member.updated' ||
      event.type === 'member.deleted' ||
      event.type.startsWith('document.') ||
      event.type === 'workspace.updated'
    ) {
      reset = true;
      continue;
    }
    if (p.message && typeof p.message === 'object') {
      const message = p.message as WorkspaceState['messages'][number];
      if (await canReadRoom(e, user, message.room))
        events.push({
          ...event,
          payload: {
            ...p,
            message: { ...message, room: publicRoom(message.room, user.id) },
          },
        });
    } else if (p.run && typeof p.run === 'object') {
      const run = p.run as RunRecord;
      if (await canReadRoom(e, user, run.room || null))
        events.push({
          ...event,
          payload: { ...p, run: publicRun(run, user.id) },
        });
    } else if (event.type === 'run.delta' || p.runId || p.messageId) {
      const messageId = typeof p.messageId === 'string' ? p.messageId : '';
      const row = messageId
        ? await e.DB.prepare('SELECT room FROM messages WHERE id=?')
            .bind(messageId)
            .first<{ room: string }>()
        : null;
      if (
        row
          ? await canReadRoom(e, user, row.room)
          : typeof p.runId === 'string' && (await canReadRun(e, user, p.runId))
      )
        events.push(event);
    } else if (event.type.startsWith('approval.')) {
      reset = true;
    } else if ((event.type === 'channel.created' || event.type === 'channel.updated')) events.push(event);
  }
  return { events, cursor: rows.at(-1)?.seq ?? after, reset };
}
export async function documentFor(
  e: BuzzEnv,
  user: TeamUser,
  id: string,
  edit = false,
) {
  const row = await e.DB.prepare('SELECT * FROM documents WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return (
    edit
      ? canEditDocument(user, mapDocument(row))
      : canReadDocument(user, mapDocument(row))
  )
    ? row
    : null;
}

// Authorize conversations before applying message/run limits. Thread audiences
// are resolved through their parents by the same policy used for API access.
export async function readableRooms(e: BuzzEnv, user: TeamUser): Promise<string[]> {
  const rows = await e.DB.prepare('SELECT DISTINCT room FROM messages UNION SELECT name AS room FROM channels').all<{ room: string }>();
  const rooms: string[] = [];
  for (const { room } of rows.results) if (await canReadRoom(e, user, room)) rooms.push(room);
  return rooms;
}
