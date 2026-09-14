import { env } from './env';
import { id, now, textValue } from '../buzz/db';
import { audit, getConfig, isAdmin } from './team';
import type { TeamUser, TerminalJob } from '../team-types';
export function mapTerminal(row: Record<string, unknown>): TerminalJob {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    deviceId: String(row.device_id),
    command: String(row.command),
    cwd: String(row.cwd),
    nextCwd: typeof row.next_cwd === 'string' ? row.next_cwd : undefined,
    status: String(row.status),
    output: String(row.output),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    error: row.error == null ? null : textValue(row.error),
    approvedBy: row.approved_by == null ? null : textValue(row.approved_by),
    createdAt: String(row.created_at),
  };
}
export async function createTerminal(
  user: TeamUser,
  input: {
    command?: unknown;
    cwd?: unknown;
    deviceId?: unknown;
    requestId?: unknown;
  },
  forceApproval = false,
) {
  const config = await getConfig();
  if (!config?.terminalEnabled)
    throw new Error('An admin must enable the workspace terminal first.');
  if (
    user.role === 'viewer' ||
    (!isAdmin(user) && config.memberTerminal === 'off')
  )
    throw new Error('Terminal execution is disabled for your role.');
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '.';
  if (!command || command.length > 8192 || command.includes('\0'))
    throw new Error('Enter a command of at most 8,192 characters.');
  if (
    cwd.startsWith('/') ||
    cwd.split(/[\\/]/).includes('..') ||
    cwd.length > 1000
  )
    throw new Error(
      'Choose a relative directory inside the device working directory.',
    );
  const deviceId =
    typeof input.deviceId === 'string' ? input.deviceId : 'local';
  if (
    !(await env.DB.prepare(
      'SELECT id FROM execution_devices WHERE id=? AND enabled=1',
    )
      .bind(deviceId)
      .first())
  )
    throw new Error('Choose an enabled execution device.');
  const requestId =
    user.id +
    ':' +
    (typeof input.requestId === 'string'
      ? input.requestId
      : crypto.randomUUID()
    ).slice(0, 120);
  const existing = await env.DB.prepare(
    'SELECT * FROM terminal_jobs WHERE request_id=?',
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (existing) return mapTerminal(existing);
  const jobId = id('terminal');
  const status = isAdmin(user) && !forceApproval ? 'queued' : 'awaiting';
  await env.DB.prepare(
    'INSERT INTO terminal_jobs(id,actor_id,device_id,command,cwd,status,approved_by,created_at,request_id) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      jobId,
      user.id,
      deviceId,
      command,
      cwd || '.',
      status,
      status === 'queued' ? user.id : null,
      now(),
      requestId,
    )
    .run();
  await audit(user.id, 'terminal.requested', {
    id: jobId,
    deviceId,
    command,
    status,
  });
  return mapTerminal(
    (await env.DB.prepare('SELECT * FROM terminal_jobs WHERE id=?')
      .bind(jobId)
      .first<Record<string, unknown>>())!,
  );
}
