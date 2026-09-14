import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { env } from './env';
import { ensureSchema, now } from '../buzz/db';
import {
  isAdmin,
  type TeamConfig,
  type TeamRole,
  type TeamUser,
} from '../team-types';
export { isAdmin };
export const SESSION_COOKIE = 'shoal_session';
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const randomToken = () =>
  randomBytes(32).toString('base64url');
const scrypt = promisify(scryptCallback);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
export function validAccount(
  username: unknown,
  name: unknown,
  password: unknown,
) {
  return (
    typeof username === 'string' &&
    /^[a-z0-9][a-z0-9._-]{2,59}$/.test(username) &&
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 60 &&
    typeof password === 'string' &&
    password.length >= 12 &&
    password.length <= 256
  );
}
export async function getConfig(): Promise<TeamConfig | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='team_config'",
  ).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as TeamConfig) : null;
}
export const defaultWorkDirectory = () =>
  resolve(
    process.env.SHOAL_WORK_DIR ||
      resolve(process.env.SHOAL_DATA_DIR || '.shoal', 'work'),
  );
export async function userById(id: string): Promise<TeamUser | null> {
  const row = await env.DB.prepare(
      'SELECT u.id,u.username,u.role,u.active,m.name FROM users u JOIN members m ON m.id=u.id WHERE u.id=? AND u.removed_at IS NULL',
    )
    .bind(id)
    .first<{
      id: string;
      username: string;
      role: TeamRole;
      active: number;
      name: string;
    }>();
  return row ? { ...row, active: !!row.active } : null;
}
export function cookieValue(request: Request) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(SESSION_COOKIE + '='))
    ?.slice(SESSION_COOKIE.length + 1);
}
export async function sessionUser(request: Request): Promise<TeamUser | null> {
  const token = cookieValue(request);
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  await ensureSchema(env);
  const session = await env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',
  )
    .bind(digest(token), now())
    .first<{ user_id: string }>();
  const user = session ? await userById(session.user_id) : null;
  return user?.active ? user : null;
}
export async function createSession(userId: string, request: Request) {
  const token = randomToken();
  await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,device,created_at,expires_at) VALUES (?,?,?,?,?)',
    )
    .bind(
      digest(token),
      userId,
      (request.headers.get('user-agent') || 'Browser').slice(0, 160),
      now(),
      new Date(Date.now() + 7 * 86400000).toISOString(),
    )
    .run();
  return token;
}
export async function audit(
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
) {
  await env.DB.prepare(
      'INSERT INTO team_activity(actor_id,action,detail,created_at) VALUES (?,?,?,?)',
    )
    .bind(actor, action, JSON.stringify(detail), now())
    .run();
}
export function actor(request: Request): TeamUser {
  // These headers are replaced by the authenticated Next proxy on every request.
  const id = request.headers.get('x-shoal-user');
  const role = request.headers.get('x-shoal-role') as TeamRole;
  if (!id || !['owner', 'admin', 'member', 'viewer'].includes(role))
    throw new Error('Authenticated user required.');
  return { id, role, username: '', name: '', active: true };
}
export async function runnerDevice(request: Request): Promise<string | null> {
  const token =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return null;
  await ensureSchema(env);
  if (
    process.env.BUZZ_RUNNER_TOKEN &&
    equalSecret(token, process.env.BUZZ_RUNNER_TOKEN)
  )
    return 'local';
  const row = await env.DB.prepare(
      'SELECT id FROM execution_devices WHERE token_hash=? AND enabled=1',
    )
    .bind(digest(token))
    .first<{ id: string }>();
  return row?.id || null;
}
export function equalSecret(value: string, expected: string) {
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function runnerPath(path: string, method: string) {
  return (method === 'POST' && (path === '/api/runs/claim' || path === '/api/compute/heartbeat' || /^\/api\/runs\/[^/]+\/(events|collaborate|context|repository)$/.test(path)))
    || (path === '/api/approvals' && ['GET', 'POST'].includes(method))
    || (method === 'POST' && /^\/api\/approvals\/[^/]+\/receipt$/.test(path));
}
