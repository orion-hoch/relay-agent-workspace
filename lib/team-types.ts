export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';
export type TeamUser = {
  id: string;
  username: string;
  name: string;
  role: TeamRole;
  active: boolean;
};
export type TeamConfig = {
  name: string;
  publicUrl: string;
  workDirectory: string;
  terminalEnabled: boolean;
  memberTerminal: 'ask' | 'off';
  terminalTimeout: number;
  networkMode: 'lan' | 'connected' | 'custom';
};
export type TerminalJob = {
  id: string;
  actorId: string;
  deviceId: string;
  command: string;
  cwd: string;
  nextCwd?: string;
  status: string;
  output: string;
  exitCode: number | null;
  error: string | null;
  approvedBy: string | null;
  createdAt: string;
};
export const isAdmin = (user: Pick<TeamUser, 'role'>) =>
  user.role === 'owner' || user.role === 'admin';
export type TeamSnapshot = {
  user: TeamUser;
  config: TeamConfig;
  members: TeamUser[];
  sessions: { id: string; device: string; current: boolean; expires_at: string }[];
  devices: { id: string; name: string; work_directory: string; enabled: number; seen_at: string | null }[];
  invites: { id: string; role: string; expires_at: string; used_at: string | null; revoked_at: string | null }[];
  activity: { id: number; actor: string; action: string; created_at: string }[];
  network: { addresses: string[]; httpsPort: string; httpsEnabled: boolean };
};
