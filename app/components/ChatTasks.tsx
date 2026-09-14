"use client";
import {useCallback, useEffect, useState} from 'react';
import {GitBranch, ListTodo} from 'lucide-react';
import {buzz, call, useBuzz} from '@/lib/buzz/store';
import {taskActive, taskStatus, type AgentTask} from '@/lib/task-types';
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription} from '@/components/ui/dialog';

export type TaskDraft = {agentId?:string; context?:string; workspaceDirectory?:string; repositoryUrl?:string; repositoryToken?:string; baseBranch?:string};
function RepositoryFields({value,onChange,disabled}:{value:TaskDraft;onChange:(value:TaskDraft)=>void;disabled:boolean}) {
  const field=(key:keyof TaskDraft,text:string)=>onChange({...value,[key]:text});
  return <div className="team-form">
    <label>Repository URL<input className="input" type="url" aria-label="Repository URL" value={value.repositoryUrl || ''} placeholder="https://github.com/team/project.git" onChange={event=>field('repositoryUrl',event.target.value)} disabled={disabled}/></label>
    <label>Base branch<input className="input" aria-label="Repository base branch" value={value.baseBranch || ''} placeholder="Default branch" onChange={event=>field('baseBranch',event.target.value)} disabled={disabled}/></label>
    <label>Access token<input className="input" type="password" aria-label="Repository access token" value={value.repositoryToken || ''} autoComplete="off" placeholder="Optional" onChange={event=>field('repositoryToken',event.target.value)} disabled={disabled}/></label>
  </div>;
}
export function useChatTasks(userId:string,room:string) {
  const [snapshot,setSnapshot]=useState<{room:string;tasks:AgentTask[]}>({room:'',tasks:[]});
  const reload=useCallback(async()=>{
    if(!room)return;
    const data=await call<{tasks:AgentTask[]}>(`/api/tasks?room=${encodeURIComponent(room)}`,{});
    setSnapshot({room,tasks:data.tasks});
  },[room]);
  useEffect(()=>{
    if(!userId || !room)return;
    const update=()=>void reload().catch(()=>{});
    update();const timer=setInterval(update,3000);return()=>clearInterval(timer);
  },[userId,room,reload]);
  return {tasks:snapshot.room===room?snapshot.tasks:[],loaded:!!room && snapshot.room===room,reload};
}
export function ChatTaskOptions({value,onChange,agents,disabled}:{value:TaskDraft;onChange:(value:TaskDraft)=>void;agents:readonly {id:string;name:string}[];disabled:boolean}) {
  const field=(key:keyof TaskDraft,text:string)=>onChange({...value,[key]:text});
  return <div className="chat-task-options team-form" aria-label="Task options">
    {agents.length!==1 && <label>Agent<select className="select" aria-label="Task agent" value={value.agentId || ''} onChange={event=>field('agentId',event.target.value)} disabled={disabled}>
      <option value="">{agents.length?'Choose an agent':'No available agents in this conversation'}</option>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select></label>}
    <details><summary>Context, files & repository</summary><div className="team-form">
      <label>Context<textarea className="input" aria-label="Task context" value={value.context || ''} maxLength={12000} rows={2} placeholder="Requirements or useful details (optional)" onChange={event=>field('context',event.target.value)} disabled={disabled}/></label>
      <label>Working directory<input className="input" aria-label="Task working directory" value={value.workspaceDirectory || ''} maxLength={500} placeholder="team/project (optional)" onChange={event=>field('workspaceDirectory',event.target.value)} disabled={disabled}/><small>The agent can read, edit and run this folder’s files. Existing project folders require an admin. Leave blank for a private task folder.</small></label>
      <details className="task-repository"><summary><GitBranch size={15}/>Repository</summary><RepositoryFields value={value} onChange={onChange} disabled={disabled}/></details>
    </div></details>
  </div>;
}
export function ChatTaskMessage({task,onOpen}:{task:AgentTask;onOpen:()=>void}) {
  return <button className="chat-task-message" onClick={onOpen} aria-label="Open task thread"><ListTodo size={16}/><strong>Task</strong><span>{taskStatus(task)}</span></button>;
}
export function ChatTaskActivity({task,onUpdated}:{task:AgentTask;onUpdated:()=>Promise<void>}) {
  const {runs}=useBuzz();
  const workers=runs.filter(run=>run.kind==='subtask' && run.parentRunId===task.run?.id);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[reviewOpen,setReviewOpen]=useState(false);
  const [review,setReview]=useState<{status:string;diff:string;truncated:boolean;head:string;output?:string}|null>(null),[commitMessage,setCommitMessage]=useState('');
  const [repositoryDraft,setRepositoryDraft]=useState<TaskDraft>({});
  async function action(kind:'stop'|'complete') {
    setBusy(true);setError('');
    try {
      if(kind==='stop' && task.run)await buzz.cancelRun(task.run.id);
      else await call('/api/tasks',{method:'POST',body:JSON.stringify({action:'complete',id:task.id})});
      await onUpdated();
    }catch(error){setError(error instanceof Error?error.message:'Could not update task.');}
    finally{setBusy(false);}
  }
  async function gitAction(action:string) {
    setBusy(true);setError('');
    try {
      setReview(await call<NonNullable<typeof review>>('/api/tasks/git',{method:'POST',body:JSON.stringify({taskId:task.id,action,message:commitMessage,...(action==='connect'?repositoryDraft:{})})}));
      if(action==='connect'){setRepositoryDraft({});await onUpdated();}
    }
    catch(error){setError(error instanceof Error?error.message:'Git operation failed.');}
    finally{setBusy(false);}
  }
  return <section className="chat-task-activity" aria-label="Task progress">
    <div className="chat-task-actions"><ListTodo size={16}/><strong>Task</strong><output aria-live="polite">{taskStatus(task)}{workers.length?` / ${workers.length} ${workers.length===1?'worker':'workers'}`:''}</output>
      {taskActive(task)?<button type="button" disabled={busy} onClick={()=>void action('stop')}>Stop task</button>:task.status!=='done' && <button type="button" disabled={busy} onClick={()=>void action('complete')}>Mark done</button>}
      {task.repository && <button type="button" disabled={busy} onClick={()=>{setReviewOpen(true);void gitAction('diff');}}><GitBranch size={15}/>Review changes</button>}
      {!task.repository && !taskActive(task) && <button type="button" disabled={busy} onClick={()=>{setError('');setReviewOpen(true);}}><GitBranch size={15}/>Connect repository</button>}
    </div>
    {task.workspaceDirectory && <small>Working directory: {task.workspaceDirectory}</small>}
    {error && !reviewOpen && <p role="alert">{error}</p>}
    <Dialog open={reviewOpen} onOpenChange={open=>{setReviewOpen(open);if(!open)setRepositoryDraft(value=>({...value,repositoryToken:undefined}));}}><DialogContent className="agent-task-dialog"><DialogHeader><DialogTitle>{task.repository?'Repository changes':'Connect repository'}</DialogTitle><DialogDescription className="sr-only">Connect a repository or review, commit and push this conversation’s task branch.</DialogDescription></DialogHeader>
      {!task.repository && <section className="team-form task-repository" aria-label="Connect task repository"><RepositoryFields value={repositoryDraft} onChange={setRepositoryDraft} disabled={busy}/><button className="btn btn-secondary" disabled={busy || taskActive(task) || !repositoryDraft.repositoryUrl?.trim()} onClick={()=>void gitAction('connect')}>Connect repository</button><small>Connect to this task’s empty working folder, then reply to continue the work. Access tokens are stored securely.</small></section>}
      {task.repository && <section className="team-form task-repository" aria-label="Task repository">
        <a href={task.repository.url} target="_blank" rel="noreferrer">{task.repository.url.replace('https://','')}</a><span><GitBranch size={16}/>{task.repository.branch}</span>
        {review ? <><pre className="task-git-diff">{review.status || 'Working tree clean'}{'\n\n'}{review.diff}</pre>{review.truncated && <small>Preview shortened.</small>}{review.output && <output>{review.output}</output>}
          <label>Commit message<input className="input" aria-label="Commit message" value={commitMessage} maxLength={1000} onChange={event=>setCommitMessage(event.target.value)}/></label>
          <div className="connection-actions"><button className="btn btn-secondary" disabled={busy || taskActive(task) || !review.status || !commitMessage.trim()} onClick={()=>void gitAction('commit')}>Commit changes</button><button className="btn btn-secondary" disabled={busy || taskActive(task) || !!review.status} onClick={()=>void gitAction('push')}>Push task branch</button></div>
        </>:busy && <output>Loading changes</output>}
      </section>}
      {error && <p role="alert">{error}</p>}
    </DialogContent></Dialog>
  </section>;
}
