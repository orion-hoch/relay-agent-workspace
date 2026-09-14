'use client';
import { useState, useLayoutEffect, useRef } from 'react';
import { call, refresh, useBuzz } from '@/lib/buzz/store';
import { isAdmin } from '@/lib/team-types';
import { agentLevel } from '@/lib/buzz/context-scope';
import { agentHome } from '@/lib/model-home';
import { DEFAULT_LAYERS, layerAllowsAgent, privacyLayer } from '@/lib/privacy-layers';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
export function ChannelDialog({open,channel,onClose,onSaved}: {open:boolean;channel?:string;onClose:()=>void;onSaved:(name:string)=>void}) {
  const {members,channelDetails=[],privacyLayers=DEFAULT_LAYERS,user}=useBuzz();
  const admin=!!user&&isAdmin(user),agents=members.filter(member=>member.kind==='agent');
  const current=channelDetails.find(item=>item.name===channel);
  const [name,setName]=useState(current?.displayName||channel||''),[level,setLevel]=useState<string>(current?.level||'Internal'),[selected,setSelected]=useState<string[]>(()=>current ? current.agents ?? agents.filter(agent=>(!Array.isArray(agent.data.channels)||agent.data.channels.includes(channel)) && layerAllowsAgent(privacyLayer(current.level,privacyLayers),agentLevel(agent,privacyLayers),agentHome(agent.data))).map(agent=>agent.id) : []),[search,setSearch]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [topic,setTopic]=useState(current?.topic || ''),[description,setDescription]=useState(current?.description || '');
  const descriptionField=useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(()=>{const field=descriptionField.current;if(field){field.style.height='auto';field.style.height=field.scrollHeight+'px';}},[description,open]);
  const eligible=agents.filter(agent=>layerAllowsAgent(privacyLayer(level,privacyLayers),agentLevel(agent,privacyLayers),agentHome(agent.data)));
  const chooseLevel=(next:string)=>{setLevel(next);setSelected(ids=>ids.filter(id=>agents.some(agent=>agent.id===id&&layerAllowsAgent(privacyLayer(next,privacyLayers),agentLevel(agent,privacyLayers),agentHome(agent.data)))));};
  async function save(){
    if(busy||!admin)return;setBusy(true);setError('');
    try{const saved=await call<{name:string}>('/api/channels',{method:channel?'PATCH':'POST',body:JSON.stringify({name:channel || name.trim().toLowerCase().replace(/\s+/g,'-'),level,agents:selected,topic,description})});await refresh();onSaved(saved.name);onClose();}
    catch(error){setError(error instanceof Error?error.message:'Could not save channel.');}finally{setBusy(false);}
  }
  return <Dialog open={open} onOpenChange={value=>{if(!value&&!busy)onClose();}}><DialogContent className="channel-dialog"><DialogHeader><DialogTitle>{channel?'Channel settings':'Create channel'}</DialogTitle><DialogDescription>Everyone in the workspace can read this channel.</DialogDescription></DialogHeader>
    <form className="channel-form" onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Channel name<input className="input" aria-label="Channel name" required maxLength={60} placeholder="product-launch" value={name} disabled={busy||!!channel||!admin} onChange={event=>setName(event.target.value)}/></label>
      <label>Topic<input className="input" aria-label="Channel topic" value={topic} maxLength={250} disabled={busy||!admin} onChange={event=>setTopic(event.target.value)}/></label>
      <label>Description<textarea ref={descriptionField} className="input channel-description" aria-label="Channel description" value={description} rows={2} maxLength={2000} disabled={busy||!admin} onChange={event=>setDescription(event.target.value)}/></label>
      <label>Classification<select className="select" aria-label="Channel classification" value={level} disabled={busy||!admin} onChange={event=>chooseLevel(event.target.value)}>{privacyLayers.map(layer=><option key={layer.name}>{layer.name}</option>)}</select></label>
      <fieldset disabled={busy||!admin}><legend>Agents ({selected.length})</legend>
        {!!agents.length && <div className="channel-agent-search"><input className="input" type="search" aria-label="Find channel agents" placeholder="Find an agent" value={search} onChange={event=>setSearch(event.target.value)}/><button className="btn btn-secondary" type="button" onClick={()=>setSelected([])}>Clear</button></div>}
        <div className="channel-agent-list">{agents.filter(agent=>agent.name.toLowerCase().includes(search.toLowerCase())).map(agent=>{
          const allowed=eligible.some(item=>item.id===agent.id);
          const reason=allowed ? (agent.data.paused?'Paused':!agent.data.modelConnection?'No model assigned':agentHome(agent.data)==='cloud'?'Cloud':'Local') : privacyLayer(level,privacyLayers).localOnly&&agentHome(agent.data)==='cloud'?'Requires a local agent':`Requires ${level} clearance`;
          return <label className="channel-agent-option" key={agent.id}><input type="checkbox" aria-label={'Add '+agent.name+' to channel'} disabled={!allowed} checked={selected.includes(agent.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,agent.id]:ids.filter(id=>id!==agent.id))}/><AgentAvatar identityKey={agent.id} label={agent.name} size={32}/><span><strong>{agent.name}</strong><small>{reason}</small></span></label>;
        })}</div>
        {!agents.length && <p>No agents yet. Create one in Habitats.</p>}{!!agents.length&&!agents.some(agent=>agent.name.toLowerCase().includes(search.toLowerCase()))&&<p>No matching agents.</p>}
      </fieldset>
      {error&&<p role="alert" className="connection-error">{error}</p>}
      <DialogFooter><button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>{admin&&<button className="btn btn-primary" disabled={busy||!name.trim()}>{busy?'Saving':channel?'Save changes':'Create channel'}</button>}</DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
