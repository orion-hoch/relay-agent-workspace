'use client';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Maximize, Minimize, CornerDownLeft } from 'lucide-react';
import { call, useBuzz } from '@/lib/buzz/store';
import { isAdmin, type TerminalJob, type TeamSnapshot } from '@/lib/team-types';
type TerminalTeam = Pick<TeamSnapshot, 'config' | 'devices'>;
const jobsOf = () => call<{ jobs: TerminalJob[] }>('/api/terminal', {});
export const terminalAction = (values: Record<string, unknown>) =>
  call<{ job?: TerminalJob }>('/api/terminal', { method: 'POST', body: JSON.stringify(values) });
export function TerminalView() {
  const { user, members } = useBuzz();
  const [jobs, setJobs] = useState<TerminalJob[]>([]), [team, setTeam] = useState<TerminalTeam | null>(null);
  const [deviceId,setDeviceId] = useState('local'), [cwd,setCwd] = useState('.');
  const [command,setCommand] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false), [expanded,setExpanded] = useState(false);
  const [clock,setClock] = useState(() => Date.now());
  const [historyIndex,setHistoryIndex] = useState(-1);
  const appliedDirectory = useRef('');
  useEffect(() => {
    const latest=jobs.find(job=>job.actorId===user?.id && job.deviceId===deviceId && job.nextCwd!==undefined && !['queued','running','awaiting'].includes(job.status));
    if(latest && appliedDirectory.current!==latest.id){appliedDirectory.current=latest.id;setCwd(latest.nextCwd!);}
  },[jobs,deviceId,user?.id]);
  const screen = useRef<HTMLDivElement>(null), transcript = useRef<HTMLElement>(null), prompt = useRef<HTMLTextAreaElement>(null), followOutput = useRef(true), historyDraft = useRef('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setClock(Date.now());
      try {
        const [data,config] = await Promise.all([jobsOf(),call<TerminalTeam>('/api/team',{})]);
        if (active) { setJobs(data.jobs); setTeam(config); }
      } catch(error) { if (active) setError(error instanceof Error ? error.message : 'Connection lost.'); }
      finally { if (active) timer=setTimeout(load,1500); }
    }
    void load();
    return () => { active=false;clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const update = () => setExpanded(document.fullscreenElement === screen.current);
    document.addEventListener('fullscreenchange',update);
    return () => document.removeEventListener('fullscreenchange',update);
  }, []);
  useEffect(() => { if (followOutput.current && transcript.current) transcript.current.scrollTop=transcript.current.scrollHeight; }, [jobs,deviceId]);
  const admin = !!user && isAdmin(user);
  const devices = team?.devices.filter(device => device.enabled) || [];
  const device = devices.find(item => item.id === deviceId);
  const connected = !!device?.seen_at && clock-Date.parse(device.seen_at)<15000;
  const canRun = !!team?.config.terminalEnabled && user?.role !== 'viewer' && (admin || team?.config.memberTerminal !== 'off') && connected;
  const visible = jobs.filter(job => job.deviceId === deviceId).toReversed();
  const history = jobs.filter(job => job.actorId === user?.id && job.deviceId === deviceId).map(job => job.command);
  const activeJob = jobs.find(job => job.actorId === user?.id && job.deviceId === deviceId && ['queued','running','awaiting'].includes(job.status));
  async function act(values: Record<string,unknown>) {
    setBusy(true);setError('');
    try {
      const data=await terminalAction(values);
      if (data.job) { setJobs(items => [data.job!,...items.filter(item => item.id !== data.job!.id)]);setCommand('');setHistoryIndex(-1);followOutput.current=true; }
      else setJobs((await jobsOf()).jobs);
    } catch(error) { setError(error instanceof Error ? error.message : 'Command failed.'); }
    finally { setBusy(false);prompt.current?.focus(); }
  }
  const notice = !team ? 'Loading terminal' : !team.config.terminalEnabled ? 'Terminal execution is paused. Enable it in Settings → Advanced workspace settings → Terminal.' : user?.role === 'viewer' || (!admin && team.config.memberTerminal === 'off') ? 'Your role cannot run commands.' : !connected ? 'Waiting for this device’s terminal runner.' : '';
  return <div className="terminal-page" ref={screen}>
    <header className="terminal-toolbar">
      <h1>Terminal</h1>
      {devices.length > 1 ? <select aria-label="Terminal device" value={deviceId} onChange={event => {setDeviceId(event.target.value);appliedDirectory.current='';setCwd('.');setHistoryIndex(-1);followOutput.current=true;}}>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select> : <span className="terminal-device">{device?.name || 'Workspace host'}</span>}
      <details className="terminal-location"><summary aria-label="Working directory" title="Current workspace folder"><FolderOpen size={16}/><span>{cwd === '.' ? 'Workspace' : `Workspace / ${cwd}`}</span></summary><div><label>Subfolder<input className="input" aria-label="Terminal folder" value={cwd} placeholder="." maxLength={1000} onChange={event => setCwd(event.target.value)} spellCheck={false}/></label></div></details>
      <button className="icon-btn terminal-expand" aria-label={expanded ? 'Exit full screen' : 'Full screen terminal'} title={expanded ? 'Exit full screen' : 'Full screen'} onClick={() => {const action=expanded ? document.exitFullscreen() : screen.current?.requestFullscreen();void action?.catch(error => setError(error.message));}}>{expanded ? <Minimize size={18}/> : <Maximize size={18}/>}</button>
    </header>
    <div className="terminal-console">
      <section className="terminal-transcript" aria-label="Terminal output" ref={transcript} onScroll={event => {const el=event.currentTarget;followOutput.current=el.scrollHeight-el.scrollTop-el.clientHeight<64;}}>
        {!visible.length && <p className="terminal-empty">Type a command below. Output appears here.</p>}
        {visible.map(job => <article className="terminal-entry" key={job.id}>
          <div className="terminal-entry-meta"><span>{job.actorId !== user?.id ? `${members.find(member => member.id === job.actorId)?.name || job.actorId} / ` : ''}{job.cwd === '.' ? 'Workspace' : job.cwd}</span><span>{job.status === 'completed' ? '' : job.exitCode !== null ? `Exit ${job.exitCode}` : job.status[0].toUpperCase()+job.status.slice(1)}</span></div>
          <pre className="terminal-command">$ {job.command}</pre>
          {job.output && <pre>{job.output}</pre>}
          {job.error && <p className="terminal-failure">{job.error}</p>}
          {job.status === 'awaiting' && <div className="terminal-job-actions"><span>Waiting for admin approval</span>{admin && <><button disabled={busy} onClick={() => void act({action:'approve',id:job.id,command:job.command,cwd:job.cwd,deviceId:job.deviceId})}>Approve exact command</button><button disabled={busy} onClick={() => void act({action:'reject',id:job.id,command:job.command,cwd:job.cwd,deviceId:job.deviceId})}>Reject</button></>}</div>}
          {['queued','running','awaiting'].includes(job.status) && <button className="terminal-cancel" disabled={busy} onClick={() => void act({action:'cancel',id:job.id})}>Cancel command</button>}
        </article>)}
      </section>
      {notice && <p className="terminal-notice">{notice}</p>}
      {error && <p role="alert" className="terminal-failure">{error}</p>}
      <form className="terminal-prompt" onSubmit={event => {event.preventDefault();if (!canRun || busy || activeJob || !command.trim()) return;void act({command,deviceId,cwd:cwd || '.',requestId:crypto.randomUUID()});}}>
        <span aria-hidden="true">$</span>
        <textarea ref={prompt} aria-label="Terminal command" value={command} rows={Math.min(4,command.split('\n').length)} maxLength={8192} placeholder={admin ? 'Enter a command' : 'Enter a command for approval'} spellCheck={false} disabled={!canRun} onChange={event => {setCommand(event.target.value);setHistoryIndex(-1);}} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault();event.currentTarget.form?.requestSubmit();}
          if (event.ctrlKey && event.key.toLowerCase() === 'c' && !event.currentTarget.value && activeJob) {event.preventDefault();void act({action:'cancel',id:activeJob.id});}
          if (['ArrowUp','ArrowDown'].includes(event.key) && !command.includes('\n')) {
            if (event.key === 'ArrowUp' && history.length) {event.preventDefault();if (historyIndex<0) historyDraft.current=command;const next=Math.min(history.length-1,historyIndex+1);setHistoryIndex(next);setCommand(history[next]);}
            if (event.key === 'ArrowDown' && historyIndex>=0) {event.preventDefault();const next=historyIndex-1;setHistoryIndex(next);setCommand(next<0 ? historyDraft.current : history[next]);}
          }
        }}/>
        <button type="submit" disabled={!canRun || busy || !!activeJob || !command.trim()} aria-label={admin ? 'Run command' : 'Request approval'} title={admin ? 'Run command' : 'Request approval'}><CornerDownLeft size={18}/></button>
      </form>
    </div>
  </div>;
}
