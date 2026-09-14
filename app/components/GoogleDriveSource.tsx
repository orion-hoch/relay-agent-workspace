'use client';
import { useCallback, useEffect, useState } from 'react';
import { call, refresh, useBuzz } from '@/lib/buzz/store';
type Snapshot = {admin: boolean; enabled: boolean; google: {configured: boolean; connected: boolean; email: string; clientId?: string; redirectUri?: string}};
type DriveFile = {id: string; name: string; mimeType: string; modifiedTime?: string};
const readFiles = (query: string, cursor = '') => call<{files: DriveFile[]; nextPageToken?: string}>(`/api/integrations/google?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`, {});
export function GoogleDriveSource({initialSearch = ''}: {initialSearch?: string}) {
  const {user} = useBuzz();
  const [snapshot,setSnapshot] = useState<Snapshot | null>(null);
  const [files,setFiles] = useState<DriveFile[]>([]), [search,setSearch] = useState(initialSearch), [cursor,setCursor] = useState(''), [imported,setImported] = useState<string[]>([]);
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [error,setError] = useState('');
  const load = useCallback(() => call<Snapshot>('/api/integrations', {}).then(setSnapshot), []);
  useEffect(() => { const update = () => void load().catch(error => setError(error.message)); update(); window.addEventListener('focus',update); return () => window.removeEventListener('focus',update); }, [load]);
  async function perform(work: () => Promise<void>) {setBusy(true);setError('');setMessage('');try {await work();}catch(error){setError(error instanceof Error ? error.message : 'Drive request failed.');}finally{setBusy(false);}}
  const listFiles = useCallback(async (next = '', query = initialSearch) => {
    const data = await readFiles(query, next);
    setFiles(current => next ? [...current,...data.files] : data.files);setCursor(data.nextPageToken || '');
  }, [initialSearch]);
  useEffect(() => {
    if (!snapshot?.google.connected) return;
    void readFiles(initialSearch).then(data => {setFiles(data.files);setCursor(data.nextPageToken || '');}).catch(error => setError(error.message));
  }, [snapshot?.google.connected, initialSearch]);
  return <section className="connection-board" aria-label="Google Drive files"><div className="team-form">
    {snapshot && !snapshot.enabled && <p>Cloud access is off. {snapshot.admin && <button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => {await call('/api/team',{method:'POST',body:JSON.stringify({action:'config',networkMode:'connected'})});await load();})}>Enable cloud access</button>}</p>}
    {user?.role === 'viewer' ? <p>Ask a member to import Drive files and share them with you.</p> : <>

      <p>{snapshot?.google.connected ? `Connected as ${snapshot.google.email}. ` : 'Sign in to choose files.'}</p>
      {!snapshot?.google.configured && <p>{snapshot?.admin ? 'Set up Google sign-in below.' : 'Ask your admin to set up Google sign-in.'}</p>}
      <div className="connection-actions">{!snapshot?.google.connected && <button className="btn btn-primary" disabled={busy || !snapshot?.google.configured || !snapshot?.enabled} onClick={() => {const popup = window.open('about:blank', 'shoal-google', 'width=620,height=760'); if (!popup) {setError('Allow this sign-in popup, then try again.'); return;} void perform(async () => {try {const data = await call<{url:string}>('/api/integrations/google', {method:'POST', body:JSON.stringify({action:'connect'})}); popup.location.href=data.url; setMessage('Complete Google sign-in in the new window, then return here.');} catch(error) {popup.close(); throw error;}});}}>Sign in with Google</button>}<button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => {await load();if (snapshot?.google.connected) await listFiles('', search);})}>Refresh</button>{snapshot?.google.connected && <button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => {const data=await call<{message:string}>('/api/integrations/google',{method:'DELETE'}); setFiles([]); setMessage(data.message); await load();})}>Disconnect Drive</button>}</div>
      {snapshot?.google.connected && <><form className="connection-actions" onSubmit={event => {event.preventDefault(); void perform(() => listFiles('', search));}}><input className="input" aria-label="Search Drive files" placeholder="Search Drive filenames" value={search} maxLength={200} onChange={event => {setSearch(event.target.value);setCursor('');}}/><button className="btn btn-secondary" disabled={busy}>Find files</button></form><div className="connection-list">{files.map(file => <div className="connection-row" key={file.id}><div><strong>{file.name}</strong><small>{file.mimeType.replace('application/vnd.google-apps.', 'Google ')}</small></div><button className="btn btn-secondary" disabled={busy || imported.includes(file.id)} onClick={() => void perform(async () => {const data=await call<{message:string}>('/api/integrations/google',{method:'POST',body:JSON.stringify({action:'import',fileId:file.id})}); setImported(current => [...current,file.id]); setMessage(data.message); await refresh();})}>{imported.includes(file.id) ? 'Added to Data' : 'Import file'}</button></div>)}</div>{cursor && <button className="btn btn-secondary" disabled={busy} onClick={() => void perform(() => listFiles(cursor, search))}>More files</button>}<small>Sheets import their first sheet.</small></>}
      {snapshot?.admin && <details><summary>Google sign-in configuration</summary><form className="connection-form" key={snapshot.google.clientId} onSubmit={event => {event.preventDefault(); const values=Object.fromEntries(new FormData(event.currentTarget)); void perform(async () => {const data=await call<{message:string}>('/api/integrations',{method:'POST',body:JSON.stringify({...values,action:'googleConfig'})}); setMessage(data.message); await load();});}}><label>Google OAuth client ID<input className="input" name="clientId" required defaultValue={snapshot.google.clientId}/></label><label>Google OAuth client secret<input className="input" name="clientSecret" type="password" autoComplete="new-password" placeholder={snapshot.google.configured ? 'Leave blank to keep saved secret' : 'Web client secret'}/></label><label>Authorized callback URL<input className="input" name="redirectUri" type="url" required defaultValue={snapshot.google.redirectUri || (typeof window !== 'undefined' ? window.location.origin + '/api/integrations/google/callback' : '')}/></label><p>Enable the Google Drive API and register this exact callback in your Google OAuth web client. For a local workspace, open it at localhost. Add teammates as test users while the Google consent screen is in Testing.</p><button className="btn btn-primary" disabled={busy}>Save Google configuration</button></form></details>}

    </>}
    {busy && <output>Working</output>}{message && <output>{message}</output>}{error && <p role="alert" className="connection-error">{error}</p>}
  </div></section>;
}
