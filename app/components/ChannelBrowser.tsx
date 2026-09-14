'use client';
import {useState} from 'react';
import {useBuzz} from '@/lib/buzz/store';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
export function ChannelBrowser({onClose,onOpen}: {onClose:()=>void;onOpen:(name:string)=>void}){
  const {channelDetails=[],hiddenRooms=[]}=useBuzz();const [search,setSearch]=useState('');
  const channels=channelDetails.filter(channel=>(channel.displayName||channel.name).includes(search.toLowerCase()));
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="channel-dialog"><DialogHeader><DialogTitle>Channels</DialogTitle><DialogDescription className="sr-only">Find or rejoin a workspace channel.</DialogDescription></DialogHeader><input className="input" type="search" aria-label="Find channels" placeholder="Find a channel" value={search} onChange={event=>setSearch(event.target.value)}/><div className="channel-browser-list">{channels.map(channel=><div className="channel-browser-row" key={channel.name}><span><strong>#{channel.displayName||channel.name}</strong>{channel.topic&&<small>{channel.topic}</small>}</span><button className="btn btn-secondary" onClick={()=>onOpen(channel.name)}>{hiddenRooms.includes(channel.name)?'Join':'Open'}</button></div>)}{!channels.length&&<p>No matching channels.</p>}</div></DialogContent></Dialog>;
}
