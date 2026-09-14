'use client';
import { Fragment, useEffect, useState } from 'react';
import { ChevronRight, Database, Search } from 'lucide-react';
import { call } from '@/lib/buzz/store';
import type { AgentActivityPage } from '@/lib/server/agent-activity';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function AgentActivity(){
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[pages,setPages]=useState(['']);
  const [snapshot,setSnapshot]=useState<AgentActivityPage|null>(null),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  const before=pages.at(-1)!;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    async function load(){
      try{
        const data=await call<AgentActivityPage>(`/api/agent-activity?q=${encodeURIComponent(query)}&before=${encodeURIComponent(before)}`,{method:'GET',signal:controller.signal});
        if(!controller.signal.aborted){setSnapshot(data);setError('');}
      }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Could not load agent activity.');}
    }
    const timer=setTimeout(()=>void load(),200),poll=setInterval(()=>void load(),5000);
    return ()=>{controller.abort();clearTimeout(timer);clearInterval(poll);};
  },[open,query,before]);
  function page(next:string[]){setPages(next);setSelected(null);setSnapshot(null);setError('');}
  return <>
    <button className="activity-source" onClick={()=>setOpen(true)}><Database size={20}/><strong>Agent activity</strong><span>Built-in database</span><ChevronRight size={18}/></button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="activity-dialog"><DialogHeader><DialogTitle>Agent activity</DialogTitle><DialogDescription className="sr-only">Saved requests, replies, and run progress from conversations you can read.</DialogDescription></DialogHeader>
      <label className="files-search"><Search size={16}/><input type="search" aria-label="Search agent activity" placeholder="Search agents, requests, or replies" value={query} onChange={event=>{setQuery(event.target.value);page(['']);}}/></label>
      {error && <p role="alert" className="connection-error">{error}</p>}
      {!snapshot ? !error && <p>Loading activity</p> : !snapshot.records.length ? <p className="activity-empty">{query?'No matching activity.':'No agent activity yet.'}</p> : <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th scope="col">Date</th><th scope="col">Agent</th><th scope="col">Request</th><th scope="col">Status</th></tr></thead><tbody>
        {snapshot.records.map(record=><Fragment key={record.id}><tr>
          <td><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></td><td>{record.agentName}</td>
          <td><button aria-label={`View ${record.agentName} activity from ${new Date(record.createdAt).toLocaleString()}`} aria-expanded={selected===record.id} onClick={()=>setSelected(selected===record.id?null:record.id)}>{record.request || 'Open recorded response'}</button></td>
          <td><span className="activity-status">{record.status[0].toUpperCase()+record.status.slice(1)}</span></td>
        </tr>{selected===record.id && <tr><td colSpan={4}><article className="activity-record">
          <div className="activity-meta"><span>{record.model}</span>{record.inputTokens!==null && <span>{record.inputTokens.toLocaleString()} input tokens</span>}{record.outputTokens!==null && <span>{record.outputTokens.toLocaleString()} output tokens</span>}</div>
          <h3>Request</h3><p>{record.request || 'No request recorded.'}</p>
          <h3>Response</h3><p>{record.response || (['queued','preparing','running','awaiting'].includes(record.status)?'Awaiting reply.':'No response recorded.')}</p>
          {record.error && <p className="connection-error">{record.error}</p>}
        </article></td></tr>}</Fragment>)}
      </tbody></table></div>}
      {(pages.length>1 || snapshot?.next) && <div className="activity-pagination"><button className="btn btn-secondary" disabled={pages.length===1} onClick={()=>page(pages.slice(0,-1))}>Newer</button><button className="btn btn-secondary" disabled={!snapshot?.next} onClick={()=>{if(snapshot?.next)page([...pages,snapshot.next]);}}>Older</button></div>}
    </DialogContent></Dialog>
  </>;
}
