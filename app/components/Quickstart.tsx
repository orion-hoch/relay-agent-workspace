'use client';
import { useEffect, useState } from 'react';
import { call, useBuzz } from '@/lib/buzz/store';
import { isAdmin } from '@/lib/team-types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
export function Quickstart({ open, onClose, onNavigate, onChat }: { open: boolean; onClose: () => void; onNavigate: (view: string) => void; onChat: (agentId: string) => void }) {
  const { user, members, documents, runs } = useBuzz();
  const [models, setModels] = useState<{models:{id:string;personal?:boolean}[]} | null>(null), [teamCount, setTeamCount] = useState(1), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const admin = !!user && isAdmin(user), agents = members.filter(member => member.kind === 'agent' && !member.data.paused);
  const refresh = () => Promise.all([
    call<{models:{id:string;personal?:boolean}[]}>('/api/connections', { method: 'GET' }).then(setModels),
    call<{ members: { active: number }[] }>('/api/team', { method: 'GET' }).then(team => setTeamCount(team.members.filter(member => member.active).length)),
  ]);
  useEffect(() => { if (open) void refresh().catch(error => setError(error.message)); }, [open]);
  async function createAssistant() {
    setBusy(true); setError('');
    try {
      const ready = models?.models.find(model => !model.personal);
      if (!ready) throw new Error('Connect a shared chat model first.');
      onClose(); onNavigate('compute');
      window.dispatchEvent(new CustomEvent('relay:open-agent'));
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create the assistant.'); }
    finally { setBusy(false); }
  }
  const go = (view: string) => { onClose(); onNavigate(view); };
  const readyCount = models?.models.filter(model => !model.personal).length || 0;
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="quickstart-dialog"><DialogHeader><DialogTitle>Get your team started</DialogTitle><DialogDescription>{admin ? 'Connect your preferred cloud or local model, create an assistant, and invite your team. You can return to this guide with /quickstart.' : 'Connect your own provider account or use a model shared by your admin. Pick an available assistant and make your first conversation useful.'}</DialogDescription></DialogHeader>
    <ol className="quickstart-steps">
      <li><span className="setup-state">{readyCount ? 'Connected' : models?.models.length ? 'Check connection' : 'To do'}</span><div><h3>Connect a model</h3><p>{readyCount ? `${readyCount} model connection${readyCount === 1 ? '' : 's'} connected. Assign a model to each agent in Habitats.` : 'Choose Add models in Habitats to add your preferred provider or a model server your team runs.'}</p>{<button className="btn btn-secondary" onClick={() => go('compute')}>View agent homes</button>}</div></li>
      <li><span className="setup-state">{agents.length ? 'Ready' : 'To do'}</span><div><h3>Create your shared assistant</h3><p>{agents.length ? `${agents.length} assistant${agents.length === 1 ? '' : 's'} available. Open a direct conversation, or mention one with @ in a channel.` : 'Start with one assistant available to your team. Customize its instructions and source access later.'}</p>{admin && !agents.length && <button className="btn btn-primary" disabled={busy || !models?.models.length} onClick={() => void createAssistant()}>{busy ? 'Creating' : 'Create team assistant'}</button>}{!!agents.length && <button className="btn btn-primary" onClick={() => { onClose(); onChat(agents[0].id); }}>Start a conversation</button>}</div></li>
      <li><span className="setup-state">{teamCount > 1 ? 'Ready' : 'Optional'}</span><div><h3>Invite teammates</h3><p>{teamCount > 1 ? `${teamCount} active accounts. Everyone signs in with their own account and keeps private conversations separate.` : 'Use Settings → Team → Invite people to create and copy an invitation link.'}</p><button className="btn btn-secondary" onClick={() => go('settings')}>{admin ? 'Invite & manage team' : 'View team'}</button></div></li>
      <li><span className="setup-state">{documents.some(document => document.status === 'ready' && document.agents.length) ? 'Ready' : 'Optional'}</span><div><h3>Add your team’s knowledge</h3><p>Upload a file in Data and choose its classification.</p><button className="btn btn-secondary" onClick={() => go('data')}>Add or share sources</button></div></li>
      <li><span className="setup-state">{runs.some(run => run.status === 'completed') ? 'Done' : 'Try it'}</span><div><h3>Get your first answer</h3><p>Ask the assistant “What can you help our team with?” Then try a question from your uploaded brief and open its citation. Use <code>/help</code> for commands.</p></div></li>
    </ol>
    {error && <p role="alert" className="connection-error">{error}</p>}<button className="btn btn-secondary" onClick={() => void refresh().catch(error => setError(error.message))}>Refresh readiness</button>
  </DialogContent></Dialog>;
}
