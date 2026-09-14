import { env } from './env';
import { seal, unseal } from '../buzz/secrets';
import { now } from '../buzz/db';
import { assertCloudAccess } from './network';
type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };
type DriveTokens = { access_token: string; refresh_token?: string; expires_at: number };
type DriveConfig = { ownerId: string; email: string };
export async function googleConfiguration(): Promise<GoogleConfig | null> {
  const row = await env.DB.prepare("SELECT secret FROM connections WHERE id='google-oauth' AND kind='google_oauth'").first<{secret: string}>();
  if (row) return JSON.parse(await unseal(env, row.secret));
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri } = process.env;
  return clientId && clientSecret && redirectUri ? {clientId, clientSecret, redirectUri} : null;
}
export async function googleConnection(userId: string) {
  const row = await env.DB.prepare("SELECT id,config,secret FROM connections WHERE id=? AND kind='google_drive'").bind('drive:' + userId).first<{id: string; config: string; secret: string}>();
  return row ? { ...row, config: JSON.parse(row.config) as DriveConfig } : null;
}
export async function googleTokenRequest(parameters: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(parameters), signal: AbortSignal.timeout(15000) });
  const result = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!response.ok || !result.access_token) throw new Error('Google authorization expired or failed. Reconnect your Google Drive account.');
  return { ...result, access_token: result.access_token, expires_at: Date.now() + Number(result.expires_in || 3600) * 1000 };
}
export async function driveToken(userId: string) {
  await assertCloudAccess(env);
  const connection = await googleConnection(userId);
  if (!connection) throw new Error('Connect your Google Drive account first.');
  const tokens = JSON.parse(await unseal(env, connection.secret)) as DriveTokens;
  if (tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  const google = await googleConfiguration();
  if (!google || !tokens.refresh_token) throw new Error('Reconnect Google Drive to renew access.');
  const refreshed = await googleTokenRequest({client_id: google.clientId, client_secret: google.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refresh_token});
  // Do not resurrect an account disconnected or replaced while refresh was in flight.
  const saved = await env.DB.prepare('UPDATE connections SET secret=? WHERE id=? AND secret=?').bind(await seal(env, JSON.stringify({...tokens, ...refreshed})), connection.id, connection.secret).run();
  if (!saved.meta.changes) throw new Error('The Google connection changed. Retry with its current authorization.');
  return refreshed.access_token;
}
export async function driveFetch(userId: string, path: string, query: Record<string, string> = {}) {
  const token = await driveToken(userId);
  const response = await fetch('https://www.googleapis.com/drive/v3/' + path + '?' + new URLSearchParams(query), {headers: {Authorization: 'Bearer ' + token}, redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Google Drive returned HTTP ${response.status}. Check account access and download permissions.`); }
  return response;
}
export async function saveDrive(userId: string, email: string, tokens: DriveTokens, pendingValue: string) {
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO connections(id,kind,name,config,secret,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret=excluded.secret')
      .bind('drive:' + userId, 'google_drive', 'Google Drive', JSON.stringify({ownerId: userId, email}), await seal(env, JSON.stringify(tokens)), now(), 'google-state:' + userId, pendingValue),
    env.DB.prepare('DELETE FROM settings WHERE key=? AND value=?').bind('google-state:' + userId, pendingValue),
  ]);
  if (!results[0].meta.changes) throw new Error('This Google sign-in was cancelled, replaced, or already completed. Connect again.');
}
