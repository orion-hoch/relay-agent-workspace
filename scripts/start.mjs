import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (existsSync('.env.local')) loadEnvFile('.env.local');
if (
  !process.env.SHOAL_OWNER_PASSWORD ||
  !process.env.SHOAL_SECRET_KEY ||
  !process.env.BUZZ_RUNNER_TOKEN
) {
  console.error(
    'Run npm run setup first, or provide SHOAL_OWNER_PASSWORD, SHOAL_SECRET_KEY, and BUZZ_RUNNER_TOKEN.',
  );
  process.exit(1);
}
const port = process.env.PORT || '3000';
process.env.BUZZ_API = `http://127.0.0.1:${port}`;
process.env.NEXT_TELEMETRY_DISABLED ||= '1';
const development = process.argv.includes('--dev');
if (development) process.env.SHOAL_DEV = '1';
const lan = process.argv.includes('--lan');
if (lan) {
  process.env.SHOAL_LAN = '1';
  process.env.SHOAL_BIND = '127.0.0.1';
}
if (!development && !existsSync('.next/BUILD_ID')) {
  console.log('Building Shoal for its first start…');
  await new Promise((resolve, reject) => {
    const build = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'build', '--webpack'],
      { stdio: 'inherit' },
    );
    build.on('error', reject);
    build.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Build failed.')),
    );
  });
}
await new Promise((resolve, reject) => {
  const migration = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/migrate.ts'],
    { stdio: 'inherit' },
  );
  migration.on('error', reject);
  migration.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('Workspace migration failed.')),
  );
});
const children = [
  spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      development ? 'dev' : 'start',
      ...(development ? ['--webpack'] : []),
      '--hostname',
      process.env.SHOAL_BIND || '127.0.0.1',
      '--port',
      port,
    ],
    { stdio: 'inherit' },
  ),
  spawn(process.execPath, ['--import', 'tsx', 'runner/ingest.ts'], {
    stdio: 'inherit',
  }),
];
children.push(
  spawn(process.execPath, ['runner/terminal.mjs'], { stdio: 'inherit' }),
);
if (lan)
  children.push(
    spawn(process.execPath, ['scripts/lan.mjs'], { stdio: 'inherit' }),
  );
if (process.env.SHOAL_EXTERNAL_RUNNER !== '1')
  children.push(
    spawn(process.execPath, ['runner/buzz-runner.mjs'], { stdio: 'inherit' }),
  );
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 3000).unref();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
