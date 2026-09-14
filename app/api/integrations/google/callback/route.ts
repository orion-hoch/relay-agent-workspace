import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/server/env';
import { digest, equalSecret, userById, audit } from '@/lib/server/team';
import { unseal } from '@/lib/buzz/secrets';
import { assertCloudAccess } from '@/lib/server/network';
import { googleConfiguration, googleTokenRequest, saveDrive } from '@/lib/server/google-drive';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  let message = 'Google Drive connected. Return to the Google Drive in Data → Add source.', success = false;
  try {
    await assertCloudAccess(env);
    const value = request.nextUrl.searchParams.get('state') || '', separator = value.indexOf('.');
    const userId = value.slice(0, separator), state = value.slice(separator + 1), cookie = request.cookies.get('shoal_google_state')?.value || '';
    if (!/^[\w-]{1,80}$/.test(userId) || !/^[\w-]{43}$/.test(state) || !equalSecret(state, cookie)) throw new Error('Google sign-in could not be verified. Return to Shoal and connect again.');
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('google-state:' + userId).first<{value: string}>();
    if (!row) throw new Error('Google sign-in expired or was already used. Connect again.');
    const pending = JSON.parse(await unseal(env, row.value)) as {state: string; expires: number; verifier: string; clientId: string; redirectUri: string};
    if (!equalSecret(pending.state, digest(state)) || pending.expires < Date.now()) throw new Error('Google sign-in expired. Connect again.');
    const user = await userById(userId), google = await googleConfiguration();
    if (!user?.active || user.role === 'viewer' || !google || pending.clientId !== google.clientId || pending.redirectUri !== google.redirectUri) throw new Error('Your account or Google configuration changed. Connect again.');
    const code = request.nextUrl.searchParams.get('code');
    if (!code || request.nextUrl.searchParams.has('error')) throw new Error('Google authorization was cancelled or denied.');
    const tokens = await googleTokenRequest({client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: google.redirectUri, grant_type: 'authorization_code', code, code_verifier: pending.verifier});
    if (tokens.scope && !tokens.scope.split(' ').includes('https://www.googleapis.com/auth/drive.readonly')) throw new Error('Google Drive read access was not granted. Connect again and allow Drive access.');
    const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {headers: {Authorization: 'Bearer ' + tokens.access_token}, redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!about.ok) { await about.body?.cancel(); throw new Error('Google Drive access could not be verified. Check that the Drive API is enabled.'); }
    const identity = await about.json() as {user?: {emailAddress?: string}};
    if (!tokens.refresh_token) throw new Error('Google did not grant offline access. Revoke the previous app grant in your Google account and reconnect.');
    await saveDrive(userId, identity.user?.emailAddress || 'Google account', tokens, row.value);
    await audit(userId, 'drive.connected', {}); success = true;
  } catch (error) { message = error instanceof Error ? error.message : 'Google sign-in failed. Return to Shoal and try again.'; }
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const response = new NextResponse(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Google Drive · Shoal</title></head><body><h1>${success ? 'Google Drive connected' : 'Connection needs attention'}</h1><p>${escape(message)}</p><p>You can close this window.</p></body></html>`, {status: success ? 200 : 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"}});
  response.cookies.set('shoal_google_state', '', {httpOnly: true, sameSite: 'lax', path: '/api/integrations/google/callback', maxAge: 0});
  return response;
}
