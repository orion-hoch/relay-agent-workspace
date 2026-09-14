'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { call, refresh, useBuzz } from '@/lib/buzz/store';
import { DEFAULT_LAYERS } from '@/lib/privacy-layers';
type Selection = {schema:string;table:string;columns:string[];limit:number};
type Source = {id?:string;name:string;engine:string;selection?:Selection;syncedAt?:string;level?:string;status?:string;error?:string};
type Table = {schema:string;name:string;columns:string[]};
type Row = Record<string,unknown>;
const emptySelection:Selection={schema:'',table:'',columns:[],limit:1000};
const newSource:Source={name:'',engine:'postgres'};
const cellText=(value:unknown)=>value==null ? 'NULL' : typeof value==='string' ? value : JSON.stringify(value);
export function DataConnections() {
  const {privacyLayers=DEFAULT_LAYERS}=useBuzz();
  const [sources,setSources]=useState<Source[]>([]),[source,setSource]=useState<Source>(newSource);
  const [address,setAddress]=useState(''),[tables,setTables]=useState<Table[]>([]),[selection,setSelection]=useState<Selection>(emptySelection);
  const [level,setLevel]=useState('Internal'),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [preview,setPreview]=useState<Row[]|null>(null),[busy,setBusy]=useState(false);
  const load=()=>call<{sources:Source[]}>('/api/sources',{}).then(data=>setSources(data.sources));
  useEffect(()=>{const update=()=>void load().catch(error=>setError(error.message));update();const timer=setInterval(update,4000);return ()=>clearInterval(timer);},[]);
  function chooseSelection(value:Selection){setSelection(value);setPreview(null);}
  async function edit(value:Source){
    setSource(value);setAddress('');setSelection(value.selection||emptySelection);setLevel(value.level||'Internal');setTables([]);setPreview(null);setMessage('');setError('');
    if(!value.id)return;
    setBusy(true);
    try{const data=await call<{tables:Table[]}>('/api/sources',{method:'POST',body:JSON.stringify({id:value.id,action:'test'})});setTables(data.tables);if(!data.tables.length)setMessage('No tables available.');}
    catch(error){setError(error instanceof Error ? error.message : 'Could not open database.');}finally{setBusy(false);}
  }
  async function perform(action:'connect'|'preview'|'import'){
    setBusy(true);setMessage('');setError('');
    const name=source.name.trim() || (source.engine==='sqlite' ? address.split(/[\\/]/).pop() || 'SQLite' : source.engine==='postgres' ? 'PostgreSQL' : 'MySQL');
    try{
      const data=await call<{id?:string;tables?:Table[];rows?:Row[]|number;truncated?:boolean}>('/api/sources',{method:'POST',body:JSON.stringify({...source,name:action==='import' && !source.name.trim() ? selection.table : name,address:address||undefined,action,selection,level})});
      if(action==='connect'){setSource({...source,name,id:data.id});setAddress('');setTables(data.tables||[]);setPreview(null);await load();if(!data.tables?.length)setMessage('No tables available.');}
      if(action==='preview')setPreview(Array.isArray(data.rows)?data.rows:[]);
      if(action==='import'){setMessage(`Imported ${typeof data.rows==='number'?data.rows:0} rows.${data.truncated ? ' Row limit reached.' : ''}`);await load();await refresh();}
    }catch(error){setError(error instanceof Error ? error.message : 'Database request failed.');}finally{setBusy(false);}
  }
  const table=tables.find(item=>item.schema===selection.schema && item.name===selection.table);
  const indexing=['queued','running'].includes(sources.find(item=>item.id===source.id)?.status||'');
  return <section className="connection-board">
    {!!sources.length && <div className="connection-list">{sources.map(item=><div className="connection-row" key={item.id}><div><strong>{item.name}</strong><small>{item.engine}{item.status ? ` / ${item.status}` : ''}</small>{item.error && !item.error.startsWith('Keyword search only:') && <small>{item.error}</small>}</div><button className="btn btn-secondary" disabled={busy} onClick={()=>void edit(item)}>Open</button><button className="btn" disabled={busy} onClick={async()=>{setBusy(true);try{await call('/api/sources?id='+item.id,{method:'DELETE'});await load();if(source.id===item.id)await edit(newSource);}catch(error){setError(error instanceof Error ? error.message : 'Could not remove source.');}finally{setBusy(false);}}}>Remove</button></div>)}</div>}
    {source.id && <button className="btn btn-secondary" disabled={busy} onClick={()=>void edit(newSource)}><Plus size={16}/>New database</button>}
    <form className="connection-form" onSubmit={event=>{event.preventDefault();void perform(source.id && selection.table ? 'import':'connect');}}>
      <details open={!source.id}><summary>Connection</summary><div className="connection-form">
        <label>Database<select className="select" aria-label="Database engine" disabled={busy || !!source.id} value={source.engine} onChange={event=>{setSource({...newSource,engine:event.target.value});setAddress('');setTables([]);chooseSelection(emptySelection);}}><option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option><option value="sqlite">SQLite</option></select></label>
        <label>{source.engine==='sqlite'?'File in .shoal/sources':'Read-only database URL'}<input className="input" aria-label="Database address" disabled={busy} type={source.engine==='sqlite'?'text':'password'} autoComplete="new-password" value={address} onChange={event=>{setAddress(event.target.value);setTables([]);setPreview(null);}} placeholder={source.id?'Leave blank to keep saved address':source.engine==='sqlite'?'knowledge.sqlite':`${source.engine}://reader:password@host/database`}/></label>
        <button className="btn btn-primary" type="button" disabled={busy || (!source.id && !address.trim())} onClick={()=>void perform('connect')}>{busy ? 'Connecting':'Connect'}</button>
      </div></details>
      {!!tables.length && <>
        <label>Table<select className="select" aria-label="Source table" disabled={busy} value={table?String(tables.indexOf(table)):''} onChange={event=>{const selected=tables[Number(event.target.value)];chooseSelection({...selection,schema:selected?.schema||'',table:selected?.name||'',columns:selected?.columns.slice(0,200)||[]});}}><option value="" disabled>Choose a table</option>{tables.map((item,index)=><option key={index} value={index}>{item.schema ? `${item.schema}.` : ''}{item.name}</option>)}</select></label>
        {table && <>
          <label>Classification<select className="select" aria-label="Database classification" disabled={busy} value={level} onChange={event=>setLevel(event.target.value)}>{privacyLayers.map(layer=><option key={layer.name}>{layer.name}</option>)}</select></label>
          <details><summary>Options</summary><div className="connection-form"><label>Name<input className="input" aria-label="Database name" value={source.name} disabled={busy} maxLength={80} placeholder={table.name} onChange={event=>setSource({...source,name:event.target.value})}/></label><label>Row limit<input className="input" aria-label="Maximum rows" type="number" disabled={busy} min={1} max={5000} value={selection.limit} onChange={event=>chooseSelection({...selection,limit:Number(event.target.value)})}/></label>
            <fieldset disabled={busy}><legend>Columns ({selection.columns.length}/{table.columns.length})</legend><button className="btn btn-secondary" type="button" onClick={()=>chooseSelection({...selection,columns:table.columns.slice(0,200)})}>Select all</button>{table.columns.map(column=><label className="team-check" key={column}><input type="checkbox" checked={selection.columns.includes(column)} disabled={!selection.columns.includes(column) && selection.columns.length>=200} onChange={event=>chooseSelection({...selection,columns:event.target.checked?[...selection.columns,column]:selection.columns.filter(name=>name!==column)})}/>{column}</label>)}</fieldset>
          </div></details>
          {indexing && <output>Indexing</output>}<div className="connection-actions"><button className="btn btn-secondary" type="button" disabled={busy || !selection.columns.length} onClick={()=>void perform('preview')}>Preview</button><button className="btn btn-primary" disabled={busy || indexing || !selection.columns.length}>{(source.syncedAt || sources.find(item=>item.id===source.id)?.syncedAt)?'Refresh table':'Import table'}</button></div>
          {preview!==null && <div className="connection-preview" aria-label="Table preview">{preview.length?<table><thead><tr>{selection.columns.map(column=><th key={column}>{column}</th>)}</tr></thead><tbody>{preview.map((row,index)=><tr key={index}>{selection.columns.map(column=><td key={column}>{cellText(row[column])}</td>)}</tr>)}</tbody></table>:<p>No rows.</p>}</div>}
        </>}
      </>}
    </form>{message && <output>{message}</output>}{error && <p role="alert" className="connection-error">{error}</p>}
  </section>;
}
