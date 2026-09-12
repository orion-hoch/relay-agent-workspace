#!/usr/bin/env node
import { cpus, totalmem, freemem, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function cpuSnapshot() {
  return cpus().reduce((snapshot, cpu) => ({
    idle: snapshot.idle + cpu.times.idle,
    total: snapshot.total + Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
  }), { idle: 0, total: 0 });
}
export function cpuPercent(previous, current) {
  if (!previous || current.total <= previous.total || current.idle < previous.idle) return null;
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / (current.total - previous.total)))));
}
export function gpuPercent(stdout) {
  const values = stdout.trim().split(/\r?\n/).map(value => /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null);
  // The habitat meter describes the busiest local GPU. Unsupported counters stay unknown.
  return values.length && values.every(value => value !== null && value >= 0 && value <= 100) ? Math.max(...values) : null;
}
async function memory() {
  const ramTotalBytes = totalmem();
  let available = freemem();
  if (process.platform === 'linux') {
    // MemAvailable excludes reclaimable cache from used memory, unlike MemFree.
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) available = Number(match[1]) * 1024;
  }
  return { ramTotalBytes, ramUsedBytes: Math.max(0, Math.min(ramTotalBytes, ramTotalBytes - available)) };
}
export function createHostSampler() {
  let previous = null;
  return async () => {
    const snapshot = cpuSnapshot();
    const cpu = cpuPercent(previous, snapshot);
    previous = snapshot;
    const [ram, gpu] = await Promise.all([
      memory(),
      exec('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 2000, maxBuffer: 4096 })
        .then(result => gpuPercent(result.stdout)).catch(() => null),
    ]);
    return { cpuPercent: cpu, gpuPercent: gpu, ...ram, measuredAt: new Date().toISOString() };
  };
}
export function startHostTelemetry(report, { keepAlive = false } = {}) {
  const sample = createHostSampler();
  let pending = false, warned = false;
  const tick = async () => {
    if (pending) return;
    pending = true;
    try { await report(await sample()); warned = false; }
    catch (error) { if (!warned) console.error(`Host telemetry unavailable: ${error.message}`); warned = true; }
    finally { pending = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 5000);
  if (!keepAlive) timer.unref();
  return () => clearInterval(timer);
}

// A separate collector can report while the existing runner finishes active chats.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--sample')) {
    console.log(JSON.stringify(await createHostSampler()()));
  } else {
    const base = (process.env.BUZZ_API || 'http://127.0.0.1:5173').replace(/\/$/, '');
    const token = process.env.BUZZ_RUNNER_TOKEN;
    if (!token) throw new Error('BUZZ_RUNNER_TOKEN is required to report host telemetry.');
    const report = async metrics => {
      const response = await fetch(`${base}/api/compute/heartbeat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ runnerId: `${hostname()}:telemetry`, metrics }), signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Telemetry endpoint returned HTTP ${response.status}`);
    };
    if (process.argv.includes('--once')) {
      const metrics = await createHostSampler()();
      await report(metrics);
      console.log(JSON.stringify(metrics));
    } else startHostTelemetry(report, { keepAlive: true });
  }
}
