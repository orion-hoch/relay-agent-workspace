import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';

if (existsSync('.env.local')) {
  loadEnvFile('.env.local');
  console.log('.env.local already exists and was preserved.');
  if (process.env.SHOAL_OWNER_PASSWORD)
    console.log('First-run setup code: ' + process.env.SHOAL_OWNER_PASSWORD);
  console.log(
    'Run npm run lan, then create your workspace or sign in with your individual account.',
  );
} else {
  const password = randomBytes(18).toString('base64url');
  writeFileSync(
    '.env.local',
    [
      '# Shoal server configuration. Keep this file private.',
      `SHOAL_OWNER_PASSWORD=${password}`,
      `SHOAL_SECRET_KEY=${randomBytes(32).toString('base64')}`,
      `BUZZ_RUNNER_TOKEN=${randomBytes(32).toString('base64url')}`,
      'SHOAL_DATA_DIR=.shoal',
      'BUZZ_API=http://127.0.0.1:3000',
      'BUZZ_CONCURRENCY=2',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  chmodSync('.env.local', 0o600);
  mkdirSync('.shoal', { recursive: true, mode: 0o700 });
  console.log(
    `Host initialized. Setup code: ${password}\nStart npm run lan for your team, or npm run dev for this computer. Create your own admin account in the first-run wizard.`,
  );
}
