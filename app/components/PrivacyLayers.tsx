import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call, refresh, useBuzz } from '@/lib/buzz/store';
import { LEVELS, type Level } from '@/lib/buzz/types';
import { DEFAULT_LAYERS, type PrivacyLayer } from '@/lib/privacy-layers';
import { isAdmin } from '@/lib/team-types';

const blank: PrivacyLayer = { name: '', clearance: 'Internal', localOnly: true };
export function PrivacyLayers() {
  const { privacyLayers = DEFAULT_LAYERS, user } = useBuzz();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PrivacyLayer>(blank);
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState(false), [replacement, setReplacement] = useState('');
  useEffect(() => {if (!message) return; const timer=setTimeout(()=>setMessage(''),5000); return ()=>clearTimeout(timer);},[message]);
  const savedLayer = privacyLayers.find(layer=>layer.name===draft.name) || draft;
  const replacements = privacyLayers.filter(layer=>layer.name!==draft.name && LEVELS.indexOf(layer.clearance)>=LEVELS.indexOf(savedLayer.clearance) && (!savedLayer.localOnly || layer.localOnly));
  const admin = !!user && isAdmin(user);
  return <section className="team-form" aria-label="Classifications">
    {privacyLayers.map(layer => <div className="classification-row" key={layer.name}>
      <span><strong>{layer.name}</strong><small>{layer.clearance} clearance / {layer.localOnly ? 'Local only' : 'Local + cloud'}</small></span>
      {admin && !LEVELS.includes(layer.name as Level) && <button className="icon-btn" aria-label={`Edit ${layer.name} classification`} title={`Edit ${layer.name}`} onClick={() => { setDraft(layer); setExisting(true); setEditing(true); setDeleting(false); setMessage(''); }}><Settings size={18}/></button>}
    </div>)}
    {admin && !editing && <button className="btn btn-secondary" onClick={() => { setDraft(blank); setExisting(false); setEditing(true); setDeleting(false); setMessage(''); }}>Add classification</button>}
    {admin && editing && <form className="team-form" onSubmit={async event => {
      event.preventDefault(); if(deleting) return; setBusy(true); setMessage('');
      try {
        await call('/api/privacy-layers', { method: 'POST', body: JSON.stringify({ ...draft, action: existing ? 'update' : 'create' }) });
        await refresh(); setEditing(false); setMessage('Classification saved.');
      } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save layer.'); }
      finally { setBusy(false); }
    }}>
      <label>Classification name<input className="input" aria-label="Classification name" required maxLength={48} disabled={existing || busy} value={draft.name} placeholder="Finance, Customer data, Research" onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>Agent clearance<select className="select" aria-label="Agent clearance" disabled={busy} value={draft.clearance} onChange={event => { const clearance = event.target.value as Level; setDraft({ ...draft, clearance, localOnly: ['Confidential', 'Restricted'].includes(clearance) || draft.localOnly }); }}>{LEVELS.map(level => <option key={level}>{level}</option>)}</select></label>
      <label className="team-check"><input type="checkbox" disabled={busy || ['Confidential', 'Restricted'].includes(draft.clearance)} checked={draft.localOnly} onChange={event => setDraft({ ...draft, localOnly: event.target.checked })}/>Local only</label>

      <div className="connection-actions"><button className="btn btn-primary" disabled={busy || deleting}>Save layer</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>{existing && !deleting && <button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>{setReplacement(replacements[0]?.name || '');setDeleting(true);setMessage('');}}>Delete classification</button>}</div>
      {deleting && <div className="team-form">
        <label>Move files and channels to<select className="select" aria-label="Replacement classification" value={replacement} disabled={busy} onChange={event=>setReplacement(event.target.value)}>{replacements.map(layer=><option key={layer.name}>{layer.name}</option>)}</select></label>
        <div className="connection-actions"><button className="btn btn-primary" type="button" disabled={busy || !replacement} onClick={async()=>{
          setBusy(true);setMessage('');
          try {await call('/api/privacy-layers',{method:'DELETE',body:JSON.stringify({name:draft.name,replacement})});await refresh();setEditing(false);setDeleting(false);setMessage('Classification deleted.');}
          catch(error){setMessage(error instanceof Error ? error.message : 'Could not delete classification.');}
          finally{setBusy(false);}
        }}>Delete {draft.name}</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>setDeleting(false)}>Keep classification</button></div>
      </div>}
    </form>}
    {message && <output>{message}</output>}
  </section>;
}
