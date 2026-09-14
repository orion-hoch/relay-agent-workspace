import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BuzzEnv } from '../buzz/db';
export function privateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) return privateAddress(value.slice(7));
  if (isIP(value) === 6)
    return value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export async function assertEndpoint(env: BuzzEnv, address: string, localOnly = false) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='team_config'",
  ).first<{ value: string }>();
  if (!localOnly && row && JSON.parse(row.value).networkMode === 'custom') return;
  const url = new URL(address),
    host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !privateAddress(item.address))
  )
    throw new Error(
      'This address is outside the local network. Use a private address or ask an admin to allow public servers in Settings → Advanced workspace settings → Network.',
    );
}

export async function assertCloudAccess(env: BuzzEnv) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='team_config'").first<{value: string}>();
  if (!row || !['connected', 'custom'].includes(JSON.parse(row.value).networkMode)) throw new Error('Cloud connections are disabled. An admin can enable cloud providers in Habitats → Add models.');
}
