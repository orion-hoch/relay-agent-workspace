// Shared Buzz record shapes. One workspace, named actors, stable IDs.
export type Level = 'Public' | 'Internal' | 'Confidential' | 'Restricted';
export const LEVELS: Level[] = ['Public', 'Internal', 'Confidential', 'Restricted'];

export type MemberRecord = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  initials: string;
  tone?: string;
  // Agent-only fields live here; humans have {}.
  data: Record<string, unknown>;
};

export type MessageRecord = {
  id: string;
  room: string;
  memberId: string;
  name: string;
  body: string;
  createdAt: string;
  runId?: string | null;
  state?: 'pending' | 'error' | 'complete' | null;
  error?: string | null;
  attachment?: { name: string; detail: string } | null;
};

export type TaskRecord = {
  id: string;
  project: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  priority: string;
  due: string;
  label: string;
  comments: string[];
  deliverable?: string | null;
  parentId?: string | null;
  criteria?: string | null;
  createdAt: string;
};

export type RunStatus = 'queued' | 'preparing' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type RunMode = 'quick' | 'deep';
export type RunRecord = {
  id: string;
  kind: 'chat' | 'task' | 'subtask';
  agentId: string;
  room?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  parentRunId?: string | null;
  status: RunStatus;
  backend: 'vllm' | 'openclaw';
  mode: RunMode;
  triggerMessageId?: string | null;
  attempt?: number;
  estimatedInputTokens?: number | null;
  model?: string | null;
  packet?: Packet | null;
  result?: string | null;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type Passage = {
  documentId: string;
  documentName: string;
  chunkId: string;
  idx: number;
  text: string;
  score: number;
  level: Level;
};

export type Packet = {
  // Submitted context; OpenClaw may add its native instructions and tool schemas.
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  mode: RunMode;
  outputReserve: number;
  budgetTokens: number;
  estimatedTokens: number;
  evidence: Passage[];
  droppedEvidence: number;
  historyMessages: number;
  droppedHistory: number;
  rulesVersion: string;
  model: string;
  backend: 'vllm' | 'openclaw';
  sessionKey: string;
};

export type DocumentRecord = {
  id: string;
  name: string;
  type: string;
  size: number;
  collection: string;
  level: Level;
  owner: string;
  audiences: string[];
  agents: string[];
  status: 'received' | 'extracting' | 'indexing' | 'ready' | 'failed' | 'stale';
  textChars: number;
  chunkCount: number;
  updatedAt: string;
  error?: string | null;
};

export type ApprovalRecord = {
  id: string;
  runId?: string | null;
  title: string;
  agent: string;
  body: string;
  source?: string | null;
  externalId?: string | null;
  sessionKey?: string | null;
  expiresAt?: string | null;
  receipt?: Record<string, unknown> | null;
  action: string; // exact proposed action, JSON
  status: 'Pending' | 'Approved' | 'Rejected';
  level: Level;
  recipient: string;
  workflow: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
};

export type NodeRecord = {
  id: string;
  name: string;
  kind: 'inference' | 'embedding' | 'rerank' | 'gateway';
  status: string;
  data: Record<string, unknown>;
  seenAt: string;
};

export type EventRecord = { seq: number; ts: string; type: string; payload: Record<string, unknown> };

export type WorkspaceState = {
  uiState: Record<string, unknown>;
  members: MemberRecord[];
  channels: string[];
  messages: MessageRecord[];
  projects: { id: string; name: string; description: string; color: string }[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  documents: DocumentRecord[];
  approvals: ApprovalRecord[];
  nodes: NodeRecord[];
  collections: string[];
  rules: string;
  cursor: number;
};
