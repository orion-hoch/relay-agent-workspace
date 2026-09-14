'use client';
import { useCallback, useEffect, useState } from 'react';
import { buzz, call } from '@/lib/buzz/store';
import { Cloud, HardDrive } from 'lucide-react';
import { ModelConnections } from './ModelConnections';
import { CLOUD_PROVIDERS } from '@/lib/cloud-providers.mjs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
type Connection = {id: string; name: string; model: string; provider: keyof typeof CLOUD_PROVIDERS; shared: boolean; copy?: boolean};
type Snapshot = {admin: boolean; enabled: boolean; defaultId: string; connections: Connection[]};
export const openModels = (tab = 'agents') => window.dispatchEvent(new CustomEvent('shoal:add-models', {detail: tab}));
export function ModelPanel() {
  const [open, setOpen] = useState(false), [tab, setTab] = useState('agents'), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [editing, setEditing] = useState<(Partial<Connection> & {provider: keyof typeof CLOUD_PROVIDERS}) | null>(null), [token, setToken] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [models, setModels] = useState<string[]>([]), [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => call<Snapshot>('/api/integrations', {}).then(setSnapshot), []);
  useEffect(() => { const show = (event: Event) => {setTab((event as CustomEvent<string>).detail || 'agents'); setOpen(true); setError(''); setMessage('');}; window.addEventListener('shoal:add-models', show); return () => window.removeEventListener('shoal:add-models', show); }, []);
  useEffect(() => { if (!open) return; const refresh = () => void load().catch(error => setError(error.message)); refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [open, load]);
  async function perform(work: () => Promise<void>) {setBusy(true); setError(''); setMessage(''); try {await work();} catch(error) {setError(error instanceof Error ? error.message : 'Connection failed.');} finally {setBusy(false);}}
  async function modelAction(action: string, connection = editing) {
    const data = await call<{message: string; models?: string[]}>('/api/integrations', {method: 'POST', body: JSON.stringify({...connection, token: connection === editing ? token : undefined, action})});
    setMessage(data.message);
    if (['save', 'default'].includes(action)) { await load();}
    if (data.models) {setModels(data.models); setFilter('');}
    if (action === 'save') {setEditing(null); setToken(undefined); await load(); await buzz.runtime();}
  }
  function newProvider(provider: keyof typeof CLOUD_PROVIDERS) {setEditing({provider, name:'', model:'', shared:false}); setToken(undefined); setModels([]); setError(''); setMessage('');}
  return <Dialog open={open} onOpenChange={value => {if (!busy) {setOpen(value); if (!value) {setToken(undefined); setEditing(null);}}}}><DialogContent className="connection-dialog integrations-dialog model-dialog"><DialogHeader><DialogTitle>Add models</DialogTitle><DialogDescription className="sr-only">Model connections</DialogDescription></DialogHeader>
    <nav className="connection-tabs" aria-label="Model types">{[
      {id:'agents',label:'Cloud AI',icon:Cloud}, {id:'local',label:'Local models',icon:HardDrive}
    ].map(item => <button key={item.id} className="btn" disabled={busy} aria-pressed={tab === item.id} onClick={() => {setTab(item.id);setEditing(null);setToken(undefined);setError('');setMessage('');}}><item.icon size={22}/>{item.label}</button>)}</nav>
    {snapshot && !snapshot.enabled && tab === 'agents' && <div className="team-notice"><p>Cloud access is currently off for this workspace.</p>{snapshot.admin ? <button className="btn btn-primary" disabled={busy} onClick={() => void perform(async () => {await call('/api/team', {method:'POST', body: JSON.stringify({action:'config', networkMode:'connected'})}); await load(); setMessage('Cloud connections enabled. Choose a provider to continue.');})}>Enable cloud connections</button> : <p>Ask an admin to enable cloud connections here.</p>}</div>}
    {tab === 'local' && (snapshot?.admin ? <ModelConnections onChange={() => {void buzz.runtime().catch(() => {}); }}/> : <p className="team-notice">Your admin adds local machines here. Their models are available through each agent’s home.</p>)}
    {tab === 'agents' && <section className="connection-board">
      {!editing ? <>
        {!!snapshot?.connections.length && <details className="connected-models"><summary>Connected models ({snapshot.connections.length})</summary><div className="connection-list">{snapshot.connections.map(connection => <article className="connection-row" key={connection.id}><div><strong>{connection.name}</strong><small>{CLOUD_PROVIDERS[connection.provider]?.name} / {connection.shared ? 'Shared' : 'Personal'}</small></div><button className="btn btn-secondary" disabled={busy} onClick={() => {setEditing(connection);setToken(undefined);setModels([]);setMessage('');setError('');}}>Manage</button></article>)}</div></details>}
        <h2>Cloud providers</h2>
        <div className="provider-grid">{Object.entries(CLOUD_PROVIDERS).map(([id, provider]) => <button key={id} disabled={busy} onClick={() => newProvider(id as keyof typeof CLOUD_PROVIDERS)}><strong>{provider.name}</strong></button>)}</div>
        <small>API usage is billed by your provider.</small>
      </> : <form className="connection-form" onSubmit={event => {event.preventDefault(); void perform(() => modelAction('save'));}}>
        <div className="connection-heading"><h2>{CLOUD_PROVIDERS[editing.provider].name}</h2><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {setEditing(null);setToken(undefined);setError('');setMessage('');}}>All providers</button></div>
        {editing.id && !editing.copy && <div className="connection-actions">{(!editing.shared || snapshot?.admin) && <button className="btn" type="button" disabled={busy} onClick={() => void perform(async () => {const result=await call<{message:string}>('/api/integrations?id='+encodeURIComponent(editing.id!),{method:'DELETE'});setEditing(null);setToken(undefined);setMessage(result.message);await load();await buzz.runtime();})}>Disconnect</button>}</div>}
        {editing.id && (!editing.shared || snapshot?.admin) && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {setEditing({...editing,copy:true,model:'',name:''});setModels([]);setMessage('Choose another model using this saved API key.');}}>Add another model with this key</button>}
        {(!editing.shared || snapshot?.admin) && <label>API key<input className="input" type="password" aria-label="Provider API key" autoComplete="new-password" value={token ?? ''} placeholder={editing.id ? 'Saved key — leave blank to keep' : 'Paste your provider API key'} onChange={event => {setToken(event.target.value || undefined);setModels([]);}}/><a href={CLOUD_PROVIDERS[editing.provider].keys} target="_blank" rel="noreferrer">Get an API key from {CLOUD_PROVIDERS[editing.provider].name}</a></label>}
        <button className="btn btn-secondary" type="button" disabled={busy || !snapshot?.enabled || (!!editing.shared && !snapshot?.admin)} onClick={() => void perform(() => modelAction('discover'))}>Find available models</button>
        {!!models.length && <label>Filter models<input className="input" type="search" placeholder="Search by model name" value={filter} onChange={event => setFilter(event.target.value)}/></label>}
        <label>Model<select aria-label="Cloud model" className="select" required value={editing.model || ''} onChange={event => setEditing({...editing,model:event.target.value})}><option value="">Choose a model</option>{[...new Set([...(editing.model ? [editing.model] : []), ...models.filter(model => model.toLowerCase().includes(filter.toLowerCase()))])].map(model => <option key={model}>{model}</option>)}</select></label>
        <details><summary>Display name & sharing</summary><div className="connection-form"><label>Display name<input className="input" maxLength={80} value={editing.name || ''} placeholder="Use model name" onChange={event => setEditing({...editing,name:event.target.value})}/></label>{snapshot?.admin && <label className="team-check"><input type="checkbox" checked={!!editing.shared} onChange={event => setEditing({...editing,shared:event.target.checked})}/>Share with the team. Requests use this API key’s billing.</label>}</div></details>
        <small>Saving runs a short model test.</small>
        <div className="connection-actions"><button className="btn btn-secondary" type="button" disabled={busy || !editing.model || !snapshot?.enabled} onClick={() => void perform(() => modelAction('test'))}>Test a reply</button>{(!editing.shared || snapshot?.admin) && <button className="btn btn-primary" disabled={busy || !editing.model || !snapshot?.enabled}>{busy ? 'Connecting' : editing.copy ? 'Test & add model' : 'Test & save model'}</button>}</div>
      </form>}
    </section>}
    {busy && <output>Working</output>}{message && <output>{message}</output>}{error && <p role="alert" className="connection-error">{error}</p>}
  </DialogContent></Dialog>;
}
