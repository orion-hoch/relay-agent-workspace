import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
const base = (process.env.BUZZ_API || 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
);
const token = process.env.SHOAL_DEVICE_TOKEN || process.env.BUZZ_RUNNER_TOKEN;
if (!token) throw new Error('Set SHOAL_DEVICE_TOKEN or run npm run setup.');
const runnerId = hostname() + ':terminal:' + randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, runnerId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`Workspace HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
let current;
function kill() {
  if (!current) return;
  try {
    process.kill(-current.pid, 'SIGTERM');
  } catch {}
  const child = current;
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 1000).unref();
}
process.on('SIGTERM', () => {
  kill();
  setTimeout(() => process.exit(0), 1200).unref();
});
process.on('SIGINT', () => {
  kill();
  setTimeout(() => process.exit(0), 1200).unref();
});
async function execute(job) {
  let seq = 0,
    queue = Promise.resolve(),
    size = 0,
    heartbeat,
    timer;
  const send = (event) => {
    const next = queue.then(async () => {
      const payload = { id: job.id, ...event, seq: seq + 1 };
      for (let attempt = 0; ; attempt++) {
        try {
          await api('/api/terminal/events', payload);
          seq++;
          return;
        } catch (error) {
          if (attempt >= 3 || error.status < 500) throw error;
          await sleep(300);
        }
      }
    });
    queue = next.catch(() => {});
    return next;
  };
  try {
    const root = await realpath(process.env.SHOAL_WORK_DIR || job.root),
      cwd = await realpath(resolve(root, job.cwd));
    if (cwd !== root && !cwd.startsWith(root + sep))
      throw new Error('The directory is outside this device workspace.');
    let finalDirectory = '';
    const script = `trap 'shoal_exit_code=$?; pwd -P >&3; exit "$shoal_exit_code"' 0\n${job.command}`;
    current = spawn('/bin/sh', ['-c', script], {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || root,
        LANG: 'en_US.UTF-8',
        TERM: 'dumb',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    current.stdio[3].setEncoding('utf8');
    current.stdio[3].on('data', text => {finalDirectory = (finalDirectory + text).slice(0, 8192);});
    let reason = '';
    heartbeat = setInterval(() => {
      void api('/api/terminal/events', { id: job.id, type: 'heartbeat' }).catch(
        (error) => {
          reason = error.message;
          kill();
        },
      );
    }, 2000);
    timer = setTimeout(() => {
      reason = 'Command exceeded the workspace time limit.';
      kill();
    }, job.timeout * 1000);
    const output = (chunk) => {
      const text = chunk.toString();
      size += Buffer.byteLength(text, 'utf8');
      if (size > 262144) {
        reason = 'Command exceeded the output limit.';
        kill();
        return;
      }
      for (let index = 0; index < text.length; index += 16384)
        void send({
          type: 'output',
          text: text.slice(index, index + 16384),
        }).catch((error) => {
          reason = error.message;
          kill();
        });
    };
    current.stdout.setEncoding('utf8');
    current.stderr.setEncoding('utf8');
    current.stdout.on('data', output);
    current.stderr.on('data', output);
    const exitCode = await new Promise((resolve, reject) => {
      current.once('error', reject);
      current.once('close', (code) => resolve(code ?? 1));
    });
    let nextCwd;
    if (finalDirectory.trim()) {
      const finalPath = await realpath(finalDirectory.trim());
      if (finalPath === root || finalPath.startsWith(root + sep)) nextCwd = relative(root,finalPath) || '.';
      else reason ||= 'The command left the workspace. The current folder was kept.';
    }
    await send({
      nextCwd,
      type: reason ? 'failed' : 'done',
      exitCode,
      error: reason || undefined,
    });
  } catch (error) {
    await send({ type: 'failed', error: error.message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    current = undefined;
  }
}
console.log('Shoal terminal runner ready on ' + hostname() + '.');
for (;;) {
  try {
    const result = await api('/api/terminal/claim', {});
    if (result.job) {
      await execute(result.job);
      continue;
    }
  } catch (error) {
    console.error(
      error.message + (error.cause?.code ? ' (' + error.cause.code + ')' : ''),
    );
    await sleep(2000);
  }
  await sleep(500);
}
