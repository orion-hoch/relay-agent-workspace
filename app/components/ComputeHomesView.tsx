'use client';
import { useId, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { ChevronDown } from 'lucide-react';
import { bytes } from '@/lib/format';
import type { AgentHome } from '@/lib/agent-homes';
export type ComputeHomeMetrics = {cpuPercent:number | null; gpuPercent:number | null; ramUsedBytes:number; ramTotalBytes:number; measuredAt:string};
type HomeView = AgentHome & {agents:ReactNode; preview:ReactNode; count:number};
function Home({home, metrics}: {home:HomeView; metrics:ComputeHomeMetrics | null}) {
  const [open,setOpen] = useState(true), id=useId();
  const percentage = (value:number | null) => value === null ? 'Unavailable' : `${Math.round(value)}%`;
  return <section className={`compute-home compute-home-${home.kind}`} data-expanded={open}>
    <div className="compute-home-header"><button className="compute-home-disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span className="compute-home-art"><Image src={home.kind === 'cloud' ? '/compute/cloud-shoal.png' : '/compute/dell-shoal.png'} alt="" width={112} height={112} unoptimized/></span><span className="compute-home-identity"><strong className="compute-home-name">{home.name}</strong><span className="compute-home-occupants"><span className="compute-home-preview" aria-hidden="true">{home.preview}</span>{home.count} {home.count === 1 ? 'agent' : 'agents'}</span></span><ChevronDown size={24}/></button><span className="home-status">{home.status === 'connected' ? 'Connected' : home.status === 'empty' ? 'No models connected' : 'Offline'}</span></div>
    {home.id === 'lab' && metrics && <div className="compute-home-resources" aria-label="Shoal runner resource usage"><div><span>CPU</span><strong>{percentage(metrics.cpuPercent)}</strong></div><div><span>GPU</span><strong>{percentage(metrics.gpuPercent)}</strong></div><div><span>Memory</span><strong>{bytes(metrics.ramUsedBytes)} / {bytes(metrics.ramTotalBytes)}</strong></div></div>}
    <div id={id} className="compute-home-interior" hidden={!open}><div className="compute-home-agents">{home.agents}</div></div>
  </section>;
}
export function ComputeHomesView({homes,metrics,onAddModels}: {homes:HomeView[];metrics:ComputeHomeMetrics | null;onAddModels:()=>void}) {
  return <div className="page compute-homes-page"><header className="compute-homes-heading"><h1>Habitats</h1><button className="btn btn-secondary" onClick={onAddModels}>Add models</button></header><div className="compute-homes-list">{!homes.length ? <p>Checking model status</p> : !homes.some(home=>home.kind==='local') && <p>No local models connected.</p>}{homes.map(home => <Home key={home.id} home={home} metrics={metrics}/>)}</div></div>;
}
