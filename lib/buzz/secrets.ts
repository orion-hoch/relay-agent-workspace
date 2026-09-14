import type { BuzzEnv } from './db';

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64');
async function key(env: BuzzEnv) {
  if (!env.SHOAL_SECRET_KEY) throw new Error('Set SHOAL_SECRET_KEY before saving connections. Run npm run setup on a new installation.');
  const raw = bytes(env.SHOAL_SECRET_KEY);
  if (raw.length !== 32) throw new Error('SHOAL_SECRET_KEY must contain 32 bytes encoded as base64.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env: BuzzEnv, value: string) {
  if (!value) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(value));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function unseal(env: BuzzEnv, value: string) {
  if (!value) return '';
  const [iv, body] = value.split('.');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await key(env), bytes(body));
  return new TextDecoder().decode(decrypted);
}
