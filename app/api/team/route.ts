import { failRun } from '@/lib/buzz/runs';
import { env } from '@/lib/server/env';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import {
  body,
  emit,
  fail,
  textValue,
  id,
  now,
  ok,
} from '@/lib/buzz/db';
import {
  actor,
  audit,
  checkPassword,
  cookieValue,
  digest,
  getConfig,
  isAdmin,
  passwordHash,
  randomToken,
  userById,
} from '@/lib/server/team';
import type { TeamConfig, TeamRole } from '@/lib/team-types';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = (await userById(actor(request).id))!;
  const config = await getConfig();
  const members = await env.DB.prepare(
    'SELECT u.id,u.username,u.role,u.active,m.name FROM users u JOIN members m ON m.id=u.id WHERE u.removed_at IS NULL ORDER BY u.created_at',
  ).all();
  const sessions = await env.DB.prepare(
    'SELECT token_hash AS id,device,created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC',
  )
    .bind(user.id, now())
    .all();
  const devices = await env.DB.prepare(
    'SELECT id,name,work_directory,enabled,seen_at FROM execution_devices ORDER BY created_at',
  ).all();
  const invites = isAdmin(user)
    ? await env.DB.prepare(
        'SELECT id,role,created_at,expires_at,used_at,revoked_at FROM invites ORDER BY created_at DESC LIMIT 100',
      ).all()
    : { results: [] };
  const activity = isAdmin(user)
    ? await env.DB.prepare(
        'SELECT a.id,a.action,a.detail,a.created_at,m.name AS actor FROM team_activity a LEFT JOIN members m ON m.id=a.actor_id ORDER BY a.id DESC LIMIT 100',
      ).all()
    : { results: [] };
  const addresses = [
    ...new Set([
      ...(process.env.SHOAL_LAN_HOSTS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      ...Object.values(networkInterfaces())
        .flat()
        .filter((item) => item?.family === 'IPv4' && !item.internal)
        .map((item) => item!.address),
    ]),
  ];
  return ok({
    user,
    config,
    members: members.results,
    sessions: sessions.results.map((row) => ({
      ...row,
      current: row.id === digest(cookieValue(request) || ''),
    })),
    devices: devices.results,
    invites: invites.results,
    activity: activity.results,
    network: {
      addresses,
      httpsPort: process.env.SHOAL_HTTPS_PORT || '8443',
      httpsEnabled: process.env.SHOAL_LAN === '1',
    },
  });
}
export async function POST(request: Request) {
  const user = actor(request);
  const p = await body<Record<string, unknown>>(request);
  if (!p) return fail('Choose an action.');
  if (p.action === 'profile') {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60)
      return fail('Enter a name of 1–60 characters.');
    await env.DB.prepare('UPDATE members SET name=?,initials=? WHERE id=?')
      .bind(p.name.trim(), p.name.trim().slice(0, 2).toUpperCase(), user.id)
      .run();
  } else if (p.action === 'password') {
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?')
      .bind(user.id)
      .first<{ password_hash: string }>();
    if (
      typeof p.oldPassword !== 'string' ||
      typeof p.password !== 'string' ||
      p.password.length < 12 ||
      p.password.length > 256 ||
      !(await checkPassword(p.oldPassword, row!.password_hash))
    )
      return fail(
        'Check your current password. The new password needs at least 12 characters.',
      );
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(
        await passwordHash(p.password),
        user.id,
      ),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
    ]);
    await audit(user.id, 'account.password_changed');
    return ok({ signInRequired: true });
  } else if (p.action === 'revokeSession') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND user_id=?')
      .bind(String(p.id), user.id)
      .run();
    await audit(user.id, 'session.revoked');
    return ok({ ok: true });
  } else {
    if (!isAdmin(user))
      return fail('This action requires a workspace admin.', 403);
    if (p.action === 'invite') {
      const role = p.role as TeamRole;
      if (
        !['admin', 'member', 'viewer'].includes(role) ||
        (role === 'admin' && user.role !== 'owner')
      )
        return fail('Choose a role you can assign.', 403);
      const hours = Math.max(1, Math.min(168, Number(p.hours) || 24));
      const token = randomToken(),
        inviteId = id('invite'),
        expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      await env.DB.prepare(
        'INSERT INTO invites(id,token_hash,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)',
      )
        .bind(inviteId, digest(token), role, user.id, now(), expiresAt)
        .run();
      await audit(user.id, 'invite.created', { id: inviteId, role });
      return ok({ token, id: inviteId, expiresAt });
    } else if (p.action === 'revokeInvite') {
      await env.DB.prepare(
        'UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL',
      )
        .bind(now(), String(p.id))
        .run();
      await audit(user.id, 'invite.revoked', { id: p.id });
    } else if (p.action === 'member' || p.action === 'removeMember') {
      const target = await userById(String(p.id));
      if (
        !target ||
        target.role === 'owner' ||
        (target.role === 'admin' && user.role !== 'owner')
      )
        return fail('This account cannot be changed by you.', 403);
      const role = (p.role || target.role) as TeamRole;
      if (
        !['admin', 'member', 'viewer'].includes(role) ||
        (role === 'admin' && user.role !== 'owner')
      )
        return fail('Choose a role you can assign.', 403);
      const removing = p.action === 'removeMember';
      const active = removing ? false : p.active === undefined ? target.active : p.active === true;
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET role=?,active=?,removed_at=? WHERE id=?').bind(
          role,
          active ? 1 : 0,
          removing ? now() : null,
          target.id,
        ),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),
        env.DB.prepare(
          "UPDATE terminal_jobs SET status='cancelled',ended_at=?,error='Account access changed.' WHERE actor_id=? AND status IN ('awaiting','queued','running')",
        ).bind(now(), target.id),
      ]);
      if (removing) {
        const pending = await env.DB.prepare("SELECT id FROM runs WHERE requested_by=? AND status IN ('queued','preparing','running','awaiting')").bind(target.id).all<{id: string}>();
        for (const run of pending.results) await failRun(env, run.id, 'The requesting member was removed.');
        await env.DB.prepare('UPDATE invites SET revoked_at=? WHERE created_by=? AND used_at IS NULL AND revoked_at IS NULL').bind(now(), target.id).run();
        await emit(env, 'member.deleted', { id: target.id });
      }
      await audit(user.id, removing ? 'member.removed' : 'member.updated', { id: target.id, role, active });
    } else if (p.action === 'config') {
      const current = (await getConfig())!;
      const next: TeamConfig = { ...current };
      if (typeof p.name === 'string' && p.name.trim() && p.name.length <= 60)
        next.name = p.name.trim();
      if (p.publicUrl !== undefined) {
        try {
          const url = new URL(textValue(p.publicUrl));
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/'
          )
            throw new Error();
          next.publicUrl = url.origin;
        } catch {
          if (p.publicUrl !== '')
            return fail('Enter the workspace HTTP(S) origin.');
          next.publicUrl = '';
        }
      }
      if (
        p.workDirectory !== undefined &&
        (typeof p.workDirectory !== 'string' ||
          resolve(p.workDirectory.trim()) !== current.workDirectory)
      ) {
        if (typeof p.workDirectory !== 'string' || !p.workDirectory.trim())
          return fail('Enter a working directory.');
        if (
          await env.DB.prepare(
            "SELECT id FROM terminal_jobs WHERE status IN ('queued','running','awaiting')",
          ).first()
        )
          return fail(
            'Finish pending terminal jobs before changing the working directory.',
            409,
          );
        next.workDirectory = resolve(p.workDirectory.trim());
        await mkdir(next.workDirectory, { recursive: true, mode: 0o700 });
      }
      if (p.terminalEnabled !== undefined)
        next.terminalEnabled = p.terminalEnabled === true;
      if (p.memberTerminal !== undefined) {
        if (!['ask', 'off'].includes(textValue(p.memberTerminal)))
          return fail('Choose Ask or Disabled.');
        next.memberTerminal = p.memberTerminal as 'ask' | 'off';
      }
      if (p.terminalTimeout !== undefined) {
        const timeout = Number(p.terminalTimeout);
        if (!Number.isInteger(timeout) || timeout < 5 || timeout > 1800)
          return fail('Timeout must be 5–1800 seconds.');
        next.terminalTimeout = timeout;
      }
      if (p.networkMode !== undefined) {
        if (!['lan', 'connected', 'custom'].includes(textValue(p.networkMode)))
          return fail('Choose local, connected, or custom networking.');
        next.networkMode = p.networkMode as 'lan' | 'connected' | 'custom';
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE settings SET value=? WHERE key='team_config'",
        ).bind(JSON.stringify(next)),
        env.DB.prepare(
          "UPDATE settings SET value=? WHERE key='ui:workspaceName'",
        ).bind(JSON.stringify(next.name)),
        env.DB.prepare(
          "UPDATE execution_devices SET work_directory=? WHERE id='local'",
        ).bind(next.workDirectory),
      ]);
      if (!next.terminalEnabled)
        await env.DB.prepare(
          "UPDATE terminal_jobs SET status='cancelled',ended_at=?,error='Terminal execution paused by an admin.' WHERE status IN ('queued','awaiting','running')",
        )
          .bind(now())
          .run();
      await audit(user.id, 'workspace.configured', {
        terminalEnabled: next.terminalEnabled,
        networkMode: next.networkMode,
      });
    } else if (p.action === 'device') {
      if (
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 80 ||
        typeof p.workDirectory !== 'string' ||
        !p.workDirectory.trim()
      )
        return fail(
          'Enter a device name and the working directory on that device.',
        );
      const deviceId = id('device'),
        token = randomToken();
      await env.DB.prepare(
        'INSERT INTO execution_devices(id,name,token_hash,work_directory,created_at) VALUES (?,?,?,?,?)',
      )
        .bind(
          deviceId,
          p.name.trim(),
          digest(token),
          p.workDirectory.trim(),
          now(),
        )
        .run();
      await audit(user.id, 'device.registered', { id: deviceId, name: p.name });
      return ok({ id: deviceId, token });
    } else if (p.action === 'revokeDevice') {
      if (p.id === 'local')
        return fail('Pause the local terminal in workspace settings.');
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE execution_devices SET enabled=0,token_hash=NULL WHERE id=?',
        ).bind(String(p.id)),
        env.DB.prepare(
          "UPDATE terminal_jobs SET status='cancelled',ended_at=?,error='Execution device revoked.' WHERE device_id=? AND status IN ('queued','awaiting','running')",
        ).bind(now(), String(p.id)),
      ]);
      await audit(user.id, 'device.revoked', { id: p.id });
    } else if (p.action === 'agentAccess') {
      if (
        !Array.isArray(p.users) ||
        p.users.some((value) => typeof value !== 'string')
      )
        return fail('Choose agent members.');
      const row = await env.DB.prepare(
        "SELECT data FROM members WHERE id=? AND kind='agent'",
      )
        .bind(String(p.id))
        .first<{ data: string }>();
      if (!row) return fail('Agent not found.', 404);
      await env.DB.prepare('UPDATE members SET data=? WHERE id=?')
        .bind(
          JSON.stringify({ ...JSON.parse(row.data), allowedUsers: p.users }),
          String(p.id),
        )
        .run();
      await audit(user.id, 'agent.access_changed', {
        id: p.id,
        users: p.users,
      });
    } else return fail('Unknown team action.');
  }
  await emit(env, 'team.changed', {});
  return ok({ ok: true });
}
