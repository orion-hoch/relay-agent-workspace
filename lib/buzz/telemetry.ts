import type { BuzzEnv } from './db';

export type ComputeHomeMetrics = {
  cpuPercent: number | null;
  gpuPercent: number | null;
  ramUsedBytes: number;
  ramTotalBytes: number;
  measuredAt: string;
};
export const TELEMETRY_KEY = 'telemetry:lab';
const TELEMETRY_MAX_AGE_MS = 30000;
export function validMetrics(value: unknown): value is ComputeHomeMetrics {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const percent = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
  return percent(m.cpuPercent) && percent(m.gpuPercent)
    && typeof m.ramTotalBytes === 'number' && Number.isSafeInteger(m.ramTotalBytes) && m.ramTotalBytes > 0
    && typeof m.ramUsedBytes === 'number' && Number.isSafeInteger(m.ramUsedBytes) && m.ramUsedBytes >= 0 && m.ramUsedBytes <= m.ramTotalBytes
    && typeof m.measuredAt === 'string' && Number.isFinite(Date.parse(m.measuredAt));
}
export function freshMetrics(value: unknown, now = Date.now()): ComputeHomeMetrics | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { receivedAt?: string; metrics?: unknown };
  if (!validMetrics(record.metrics)) return null;
  const received = Date.parse(record.receivedAt || '');
  const measured = Date.parse(record.metrics.measuredAt);
  if (!Number.isFinite(received) || now - received > TELEMETRY_MAX_AGE_MS || now - measured > TELEMETRY_MAX_AGE_MS || received > now + 5000 || measured > now + 5000) return null;
  return record.metrics;
}
export async function readHostMetrics(env: BuzzEnv): Promise<ComputeHomeMetrics | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(TELEMETRY_KEY).first<{ value: string }>();
  if (!row) return null;
  try { return freshMetrics(JSON.parse(row.value)); } catch { return null; }
}
