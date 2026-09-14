import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '@/lib/server/env';
import { actor, digest, audit } from '@/lib/server/team';
import { assertCloudAccess } from '@/lib/server/network';
import { body, fail, ok } from '@/lib/buzz/db';
import { seal, unseal } from '@/lib/buzz/secrets';
import { driveFetch, googleConfiguration, googleConnection } from '@/lib/server/google-drive';
import { storeDocument } from '@/lib/server/documents';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams, search = (query.get('search') || '').slice(0, 200), cursor = query.get('cursor') || '';
  if (cursor.length > 2000) return fail('Invalid page cursor.');
  const escaped = search.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  try {
    const response = await driveFetch(actor(request).id, 'files', { q: `trashed=false and mimeType != 'application/vnd.google-apps.folder'${search ? ` and name contains '${escaped}'` : ''}`, pageSize: '50', fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', orderBy: 'modifiedTime desc', ...(cursor ? {pageToken: cursor} : {}), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    return ok(await response.json());
  } catch (error) { return fail(error instanceof Error ? error.message : 'Drive could not be read.', 400); }
}
export async function POST(request: NextRequest) {
  const user = actor(request), p = await body<{action?: string; fileId?: string}>(request);
  if (user.role === 'viewer') return fail('Viewers cannot import files or connect accounts.', 403);
  try {
    await assertCloudAccess(env);
    if (p?.action === 'connect') {
      const google = await googleConfiguration();
      if (!google) return fail('An admin must configure the Google Drive in Data → Add source first.', 409);
      if (new URL(google.redirectUri).origin !== new URL(request.url).origin && new URL(google.redirectUri).host !== request.headers.get('host')) return fail('Open Shoal at the origin configured for Google sign-in before connecting.', 409);
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      // Keep at most one pending grant per account; the proof cookie binds the callback to this browser.
      const key = 'google-state:' + user.id;
      await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, await seal(env, JSON.stringify({state: digest(state), verifier, expires: Date.now() + 600000, clientId: google.clientId, redirectUri: google.redirectUri}))).run();
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: google.clientId, redirect_uri: google.redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'consent', state: user.id + '.' + state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      const response = NextResponse.json({url: url.href});
      response.headers.set('Cache-Control', 'no-store');
      response.cookies.set('shoal_google_state', state, {httpOnly: true, sameSite: 'lax', secure: new URL(google.redirectUri).protocol === 'https:', path: '/api/integrations/google/callback', maxAge: 600});
      return response;
    }
    if (p?.action !== 'import' || !p.fileId || !/^[\w-]{1,200}$/.test(p.fileId)) return fail('Choose a Drive file to import.');
    const response = await driveFetch(user.id, 'files/' + p.fileId, {fields: 'id,name,mimeType,size', supportsAllDrives: 'true'});
    const file = await response.json() as {name: string; mimeType: string; size?: string};
    const exports: Record<string, {type: string; extension: string}> = {
      'application/vnd.google-apps.document': {type: 'text/plain', extension: '.txt'},
      'application/vnd.google-apps.presentation': {type: 'text/plain', extension: '.txt'},
      'application/vnd.google-apps.spreadsheet': {type: 'text/csv', extension: '.csv'},
    };
    const format = exports[file.mimeType];
    if (file.mimeType.startsWith('application/vnd.google-apps.') && !format) return fail('Import a Google Doc, Sheet, or Slides file, or a supported uploaded document.');
    if (Number(file.size || 0) > 25 * 1024 * 1024) return fail('Drive files over 25 MB are not supported.', 413);
    const download = await driveFetch(user.id, 'files/' + p.fileId + (format ? '/export' : ''), format ? {mimeType: format.type} : {alt: 'media', supportsAllDrives: 'true'});
    if (!download.body) throw new Error('Google returned an empty download.');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > 25 * 1024 * 1024) throw new Error('Drive download exceeds the 25 MB import limit.');
      chunks.push(chunk);
    }
    if (!await googleConnection(user.id)) return fail('Google Drive was disconnected during this import.', 409);
    const document = await storeDocument(env, user.id, new File([Buffer.concat(chunks)], file.name + (format?.extension || ''), {type: format?.type || file.mimeType}), {collection: 'Google Drive'});
    await audit(user.id, 'drive.imported', { documentId: document.id, fileId: p.fileId });
    return ok({document, message: 'Imported a private snapshot. Manage sharing in Data.'}, 202);
  } catch (error) { return fail(error instanceof Error ? error.message : 'Google Drive request failed.', 400); }
}
export async function DELETE(request: Request) {
  const user = actor(request), connection = await googleConnection(user.id);
  if (connection) {
    const tokens = JSON.parse(await unseal(env, connection.secret)) as {refresh_token?: string; access_token: string};
    await env.DB.prepare('DELETE FROM connections WHERE id=?').bind(connection.id).run();
    // Local disconnect succeeds even if Google is temporarily unreachable.
    const revoked = await fetch('https://oauth2.googleapis.com/revoke', {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: tokens.refresh_token || tokens.access_token}), signal: AbortSignal.timeout(8000)}).catch(() => null);
    await revoked?.body?.cancel();
  }
  await env.DB.prepare('DELETE FROM settings WHERE key=?').bind('google-state:' + user.id).run();
  return ok({message: 'Drive disconnected. Imported snapshots remain in Data; remove them there if needed.'});
}
