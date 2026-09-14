'use client';
import { useEffect, useState } from 'react';
import { call } from '@/lib/buzz/store';
import { Monitor, Server } from 'lucide-react';

type Connection = { id?: string; kind: string; name: string; url: string; model: string; nodeName?: string; contextWindow: number; execution: string; runtimeModel?: string; hasToken?: boolean };
type Snapshot = { connections: Connection[]; models: {id:string; name:string; provider?:string}[]; selected: string; gatewayConfigured: boolean };
const presets = [
  {name:'Ollama', url:'http://localhost:11434/v1', help:'Open Ollama and download a chat model. If it is not running, start it with ollama serve.'},
  {name:'LM Studio', url:'http://localhost:1234/v1', help:'Load a model in LM Studio, open Developer, and start its local server.'},
  {name:'vLLM', url:'http://localhost:8000/v1', help:'Start your vLLM server. Its usual API port is 8000.'},
  {name:'Other server', url:'http://localhost:8000/v1', help:'Use the OpenAI-compatible API address of your server. Native tool runtimes are in Advanced.'},
];
const empty: Connection = {kind:'model', name:'', url:presets[0].url, model:'', contextWindow:4096, execution:'vllm', runtimeModel:'', nodeName:'This computer'};
export function ModelConnections({ onChange }: { onChange: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [editing, setEditing] = useState<Connection | null>(null);
  const [preset, setPreset] = useState(0), [remote, setRemote] = useState(false), [token, setToken] = useState<string | undefined>();
  const [models, setModels] = useState<string[]>([]), [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = () => call<Snapshot>('/api/connections', {}).then(setSnapshot);
  useEffect(() => {void load().catch(error => setError(error.message));}, []);
  function edit(value: Connection) {setEditing(value); setToken(undefined); setModels([]); setMessage(''); setError(''); setRemote(!['localhost','127.0.0.1','[::1]','host.docker.internal'].includes(new URL(value.url).hostname)); setPreset(Math.max(0,presets.findIndex(preset => preset.url === value.url)));}
  async function request(action: string) {
    if (!editing) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const data = await call<{models?:string[]; latencyMs?:number; message?:string}>('/api/connections', {method:'POST',body:JSON.stringify({...editing, name:editing.name || editing.model, token, action})});
      if (data.models) setModels(data.models);
      if (action === 'discover') {
        setEditing(current => current ? {...current, model:data.models?.includes(current.model) ? current.model : data.models?.length === 1 ? data.models[0] : ''} : current);
        setMessage(data.models?.length ? 'Server reached. Choose a model below.' : 'Server reached, but no models are loaded. Load a chat model in your server and check again.');
      } else if (action === 'test') setMessage(`Reply received in ${data.latencyMs} ms: ${data.message || ''}`);
      else {await load(); setEditing(null); setToken(undefined); setMessage('Model connected. Choose its machine in Agent Home.'); onChange();}
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Connection failed.');}
    finally {setBusy(false);}
  }
  return <section className="connection-board" aria-label="Local models">
    {!editing ? <>
      <div className="connection-heading"><h2>Model servers</h2><button className="btn btn-primary" onClick={() => edit({...empty})}>Add local model</button></div>
      <div className="connection-list">{snapshot?.connections.map(connection => <article className="connection-row" key={connection.id}><div><strong>{connection.name}</strong><small>{connection.nodeName || new URL(connection.url).hostname} / {connection.model}</small></div><button className="btn btn-secondary" onClick={() => edit(connection)}>Manage</button><button className="btn" disabled={busy} onClick={() => {setBusy(true); void call(`/api/connections?id=${encodeURIComponent(connection.id!)}`,{method:'DELETE'}).then(async () => {await load(); onChange();},error => setError(error.message)).finally(() => setBusy(false));}}>Remove</button></article>)}</div>
      {!!snapshot?.models.some(model => !model.provider) && <label className="connection-default">Default local model<select className="select" value={snapshot.selected} onChange={event => void call('/api/connections',{method:'POST',body:JSON.stringify({action:'select',id:event.target.value})}).then(async () => {await load(); onChange();},error => setError(error.message))}>{snapshot.models.filter(model => !model.provider).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
      {!snapshot?.connections.length && <p className="connection-empty">No local models connected.</p>}
    </> : <form className="connection-form" onSubmit={event => {event.preventDefault(); void request('save');}}>
      <div className="connection-heading"><h2>{editing.id ? 'Manage local model' : 'Connect a local model'}</h2><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {setEditing(null);setToken(undefined);setError('');}}>Back to machines</button></div>
      {!editing.id && <><label>Model server<select aria-label="Model server" className="select" value={preset} onChange={event => {const index=Number(event.target.value); setPreset(index); setModels([]); setEditing({...editing,url:presets[index].url,contextWindow:index === 0 ? 4096 : 32768,model:'',nodeName:'This computer'}); setRemote(false);}}>{presets.map((preset,index) => <option key={preset.name} value={index}>{preset.name}</option>)}</select></label><p className="connection-tip">{presets[preset].help}</p></>}
      <div className="connection-segments" aria-label="Machine location"><button type="button" aria-pressed={!remote} disabled={busy} onClick={() => {setRemote(false);setEditing({...editing,url:presets[preset].url,nodeName:'This computer'});setModels([]);}}><Monitor size={22}/>This computer</button><button type="button" aria-pressed={remote} disabled={busy} onClick={() => {setRemote(true);setEditing({...editing,nodeName:remote ? editing.nodeName : '',url:remote ? editing.url : ''});setModels([]);}}><Server size={22}/>Another machine</button></div>
      {remote && <label>Machine name<input className="input" required maxLength={80} placeholder="Dell workstation" value={editing.nodeName || ''} onChange={event => setEditing({...editing,nodeName:event.target.value})}/></label>}
      <label>Server address<input className="input" type="url" aria-label="Server address" required value={editing.url} placeholder="http://192.168.1.50:11434/v1" onChange={event => {setEditing({...editing,url:event.target.value,model:''});setModels([]);}}/><small>{remote ? 'Use the machine’s LAN address. Enable network serving in Ollama or LM Studio and allow the port through its firewall.' : 'Localhost means the computer running Shoal. For Docker, use host.docker.internal.'}</small></label>
      <details><summary>API key & advanced settings</summary><div className="connection-form">
        <label>API key (optional)<input className="input" type="password" autoComplete="new-password" value={token ?? ''} placeholder={editing.hasToken ? 'Leave blank to keep the saved key' : 'Only if your server requires it'} onChange={event => setToken(event.target.value || undefined)}/></label>
        <label>Purpose<select className="select" disabled={!!editing.id} value={editing.kind} onChange={event => setEditing({...editing,kind:event.target.value})}><option value="model">Chat / agent model</option><option value="embedding">Embeddings</option><option value="rerank">Reranking</option></select></label>
        <label>Connection name<input className="input" maxLength={80} value={editing.name} placeholder="Use model name" onChange={event => setEditing({...editing,name:event.target.value})}/></label>
        {editing.kind === 'model' && <><label>Execution<select className="select" value={editing.execution} onChange={event => setEditing({...editing,execution:event.target.value})}><option value="vllm">Chat with your sources</option><option value="openclaw">OpenClaw agents and tools</option></select></label><label>Context window<input className="input" type="number" min={2048} max={2000000} value={editing.contextWindow} onChange={event => setEditing({...editing,contextWindow:Number(event.target.value)})}/><small>Match the context configured in your model server. Ollama starts at 4,096 tokens.</small></label>{editing.execution === 'openclaw' && <label>OpenClaw provider/model<input className="input" value={editing.runtimeModel || ''} onChange={event => setEditing({...editing,runtimeModel:event.target.value})}/><small>{snapshot?.gatewayConfigured ? 'Use a model configured in your native runtime.' : 'Set up your OpenClaw gateway using the README.'}</small></label>}</>}
        {!models.length && <label>Model ID (manual)<input className="input" value={editing.model} onChange={event => setEditing({...editing,model:event.target.value})}/></label>}
      </div></details>
      <button className="btn btn-secondary" type="button" disabled={busy || !editing.url} onClick={() => void request('discover')}>{busy ? 'Checking server' : 'Check server & find models'}</button>
      {!!models.length && <label>Model<select aria-label="Local model" className="select" required value={editing.model} onChange={event => setEditing({...editing,model:event.target.value})}><option value="">Choose a model</option>{models.map(model => <option key={model}>{model}</option>)}</select></label>}
      {!!editing.model && <div className="connection-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void request('test')}>Test a reply</button><button className="btn btn-primary" disabled={busy}>Save model</button></div>}
    </form>}
    {message && <output>{message}</output>}{error && <p className="connection-error" role="alert">{error}</p>}
  </section>;
}
