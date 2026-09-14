import { randomBytes } from 'node:crypto';
import { env } from '../lib/server/env';
import { ensureSchema } from '../lib/buzz/db';
import { passwordHash, audit } from '../lib/server/team';
const username = process.argv[2]?.trim().toLowerCase();
try {
  if (!username) throw new Error('Usage: npm run account:reset -- username');
  await ensureSchema(env);
  const user = await env.DB.prepare('SELECT id FROM users WHERE username=?')
    .bind(username)
    .first<{ id: string }>();
  if (!user) throw new Error('Account not found.');
  const password = randomBytes(24).toString('base64url');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash=?,active=1 WHERE id=?').bind(
      await passwordHash(password),
      user.id,
    ),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
  ]);
  await audit(user.id, 'account.recovered_by_host');
  console.log(
    `New password for ${username}: ${password}\nAll sessions were signed out. Change this password in account settings.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Recovery failed.');
  process.exitCode = 1;
} finally {
  await env.DB.close();
}
