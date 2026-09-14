import { env } from '@/lib/server/env';
import { NextResponse, type NextRequest } from 'next/server';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  body,
  emit,
  ensureSchema,
  fail,
  now,
  ok,
} from '@/lib/buzz/db';
import {
  audit,
  checkPassword,
  cookieValue,
  createSession,
  defaultWorkDirectory,
  digest,
  equalSecret,
  getConfig,
  passwordHash,
  SESSION_COOKIE,
  sessionUser,
  userById,
  validAccount,
} from '@/lib/server/team';
import type { TeamConfig } from '@/lib/team-types';

let attempts = { count: 0, until: 0 };
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const config = await getConfig();
  const user = await sessionUser(request);
  return ok({
    configured: !!config,
    name: config?.name || 'Shoal',
    user,
    authenticated: !!user,
  });
}
export async function POST(request: NextRequest) {
  if (!request.headers.get('origin'))
    return fail('Open this request from your workspace.', 403);
  if (!process.env.SHOAL_SECRET_KEY || !process.env.SHOAL_OWNER_PASSWORD)
    return fail('Run npm run setup, then restart Shoal.', 503);
  if (attempts.until < Date.now())
    attempts = { count: 0, until: Date.now() + 60000 };
  if (++attempts.count > 40)
    return fail('Too many attempts. Try again in a minute.', 429);
  const p = await body<{
    action?: string;
    username?: string;
    name?: string;
    password?: string;
    setupCode?: string;
    workspaceName?: string;
    workDirectory?: string;
    invite?: string;
    terminalEnabled?: boolean;
  }>(request);
  if (!p || typeof p.password !== 'string' || p.password.length > 256)
    return fail('Enter your account details.');
  await ensureSchema(env);
  const username =
    typeof p.username === 'string' ? p.username.trim().toLowerCase() : '';
  let userId: string;
  if (p.action === 'create') {
    if (await getConfig())
      return fail('This workspace already has an owner.', 409);
    if (
      typeof p.setupCode !== 'string' ||
      !equalSecret(p.setupCode, process.env.SHOAL_OWNER_PASSWORD)
    )
      return fail('Enter the setup code from the host terminal.', 401);
    if (!validAccount(username, p.name, p.password))
      return fail(
        'Use a 3–60 character username, your name, and a password of at least 12 characters.',
      );
    if (
      typeof p.workspaceName !== 'string' ||
      !p.workspaceName.trim() ||
      p.workspaceName.length > 60
    )
      return fail('Enter a workspace name of 1–60 characters.');
    const workDirectory = p.workDirectory?.trim()
      ? resolve(p.workDirectory.trim())
      : defaultWorkDirectory();
    await mkdir(workDirectory, { recursive: true, mode: 0o700 });
    const config: TeamConfig = {
      name: p.workspaceName.trim(),
      publicUrl: '',
      workDirectory,
      terminalEnabled: p.terminalEnabled === true,
      memberTerminal: 'ask',
      terminalTimeout: 120,
      networkMode: 'lan',
    };
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)',
      ).bind('you', username, await passwordHash(p.password), 'owner', now()),
      env.DB.prepare("UPDATE members SET name=?,initials=? WHERE id='you'").bind(
        p.name!.trim(),
        p.name!.trim().slice(0, 2).toUpperCase(),
      ),
      env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES ('team_config',?)",
      ).bind(JSON.stringify(config)),
      env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES ('ui:workspaceName',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(JSON.stringify(config.name)),
      env.DB.prepare(
        "INSERT INTO execution_devices(id,name,work_directory,created_at) VALUES ('local','Workspace host',?,?) ON CONFLICT(id) DO UPDATE SET work_directory=excluded.work_directory",
      ).bind(workDirectory, now()),
    ]);
    userId = 'you';
    await audit(userId, 'workspace.created', { name: config.name });
  } else if (p.action === 'join') {
    if (
      !validAccount(username, p.name, p.password) ||
      typeof p.invite !== 'string' ||
      !/^[\w-]{43}$/.test(p.invite)
    )
      return fail(
        'Enter a valid invitation and account details. Passwords need at least 12 characters.',
      );
    const invite = await env.DB.prepare(
      'SELECT id,role FROM invites WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?',
    )
      .bind(digest(p.invite), now())
      .first<{ id: string; role: string }>();
    if (!invite)
      return fail(
        'This invitation expired, was revoked, or has already been used.',
        410,
      );
    if (
      await env.DB.prepare('SELECT id FROM users WHERE username=?')
        .bind(username)
        .first()
    )
      return fail('That username is already taken.', 409);
    userId = 'user_' + crypto.randomUUID().replaceAll('-', '');
    const stamp = now();
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO users(id,username,password_hash,role,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM invites WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?)',
        ).bind(
          userId,
          username,
          await passwordHash(p.password),
          invite.role,
          stamp,
          invite.id,
          stamp,
        ),
        env.DB.prepare(
          "INSERT INTO members(id,kind,name,initials,data) SELECT ?,'human',?,?,'{}' WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",
        ).bind(
          userId,
          p.name!.trim(),
          p.name!.trim().slice(0, 2).toUpperCase(),
          userId,
        ),
        env.DB.prepare(
          'UPDATE invites SET used_at=? WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=?)',
        ).bind(stamp, invite.id, userId),
      ]);
      if (!results[0].meta.changes)
        return fail('This invitation was already used.', 410);
    } catch {
      return fail(
        'Account creation failed. The username or invitation may already be used.',
        409,
      );
    }
    await audit(userId, 'member.joined', { inviteId: invite.id });
  } else {
    const row = await env.DB.prepare(
      'SELECT id,password_hash,active FROM users WHERE username=?',
    )
      .bind(username)
      .first<{ id: string; password_hash: string; active: number }>();
    const valid = await checkPassword(
      p.password,
      row?.password_hash ||
        '00000000000000000000000000000000:' + '0'.repeat(128),
    );
    if (!row || !row.active || !valid)
      return fail('Incorrect username or password.', 401);
    userId = row.id;
  }
  if (p.action === 'create' || p.action === 'join')
    await emit(env, 'team.changed', {});
  const response = NextResponse.json({
    authenticated: true,
    user: await userById(userId),
  });
  response.cookies.set(SESSION_COOKIE, await createSession(userId, request), {
    httpOnly: true,
    sameSite: 'strict',
    secure:
      process.env.SHOAL_COOKIE_SECURE === '1' ||
      request.headers.get('x-shoal-https') === '1' ||
      new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: 604800,
  });
  return response;
}
export async function DELETE(request: NextRequest) {
  if (!request.headers.get('origin')) return fail('Forbidden', 403);
  const token = cookieValue(request);
  if (token)
    await env
      .DB.prepare('DELETE FROM sessions WHERE token_hash=?')
      .bind(digest(token))
      .run();
  const response = NextResponse.json({ authenticated: false });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
