import { buzz, call, useBuzz } from '@/lib/buzz/store';
import { isAdmin } from '@/lib/team-types';
import { DEFAULT_LAYERS } from '@/lib/privacy-layers';
import { openModels } from './ModelPanel';
import { agentHomeId, modelFitsHome } from '@/lib/model-home';
import { ComputeHomesView } from './ComputeHomesView';
import { AgentThinkingBubble } from "@/components/AgentThinkingBubble";
import {
  useAgentMembers,
  useWorkspaceMembers,
  removeWorkspaceAgent,
  type AgentMember as Agent,
} from "@/lib/workspace-members";
// Identity-card layout adapted from block/buzz; see third-party notices.
import { useEffect, useRef, useState } from "react";
import { Cloud, Plus, Pencil } from "lucide-react";
import { agentInitials } from '@/lib/avatar';
import { AgentAvatar } from "@/components/AgentAvatar";
import { useAgentHomes } from "@/lib/agent-homes";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
type Props = { onNotify?: (message: string) => void };
export function AgentsView({ onNotify }: Props) {
  const { user, runtime, privacyLayers=DEFAULT_LAYERS } = useBuzz();
  const admin=!!user&&isAdmin(user);
  const homes = useAgentHomes();
  const agents = useAgentMembers();
  const members = useWorkspaceMembers();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameCustomized, setNameCustomized] = useState(false);
  const [avatar, setAvatar] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [homeId, setHomeId] = useState("");
  const [accessLevel, setAccessLevel] = useState<string>("Confidential");
  const [modelConnection, setModelConnection] = useState('');
  const [models, setModels] = useState<{ id: string; name: string; provider?: string; homeId?: string; personal?: boolean }[]>([]);
  const [paused, setPaused] = useState(false);
  const [networkAccess, setNetworkAccess] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newlyCreatedId, setNewlyCreatedId] = useState<string | null>(null);
  const createdCard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newlyCreatedId) return;
    const frame = requestAnimationFrame(() =>
      createdCard.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [newlyCreatedId]);
  function openAgent(agent?: Agent, preferredKind?: "local" | "cloud", preferredHome?: string) {
    setEditingId(agent?.id || null);
    setPaused(agent?.paused === true);
    setNetworkAccess(agent?.networkAccess === true);
    setAvatar(agent?.avatar || '');
    setModelConnection(agent?.modelConnection || '');
    void call<{ models: { id: string; name: string; provider?: string; homeId?: string; personal?: boolean }[] }>('/api/connections', {}).then(data => setModels(data.models.filter(model => !model.personal))).catch(() => setModels([]));
    setName(agent?.name || '');
    setNameCustomized(agent?.nameCustomized ?? false);
    const initialHome =
      homes.find(home => !agent && home.id === preferredHome) ||
      homes.find((home) => !agent && home.kind === preferredKind) ||
      homes.find((home) => home.id === agent?.homeId) ||
      homes.find(
        (home) => agent && agent.device.startsWith(home.name) && home.kind === agent.runtime,
      ) ||
      homes.find((home) => home.kind === (agent?.runtime || "local"));
    setHomeId(initialHome?.id || "");
    setAccessLevel(
      agent?.accessLevel || (initialHome?.kind === "cloud" ? "Public" : "Confidential"),
    );
    setInstructions(agent?.instructions ?? agent?.description ?? "");
    setError("");
    setDialogOpen(true);
  }
  useEffect(() => {
    const onOpenAgent = (event: Event) => {
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      const agent = agents.find((member) => member.id === agentId);
      if (agent) openAgent(agent);
      else if (!agentId) openAgent();
    };
    window.addEventListener("relay:open-agent", onOpenAgent);
    return () => window.removeEventListener("relay:open-agent", onOpenAgent);
  });
  async function saveAgent() {
    if (saving || uploading) return;
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    if (
      members.some(
        (agent) =>
          agent.id !== editingId &&
          agent.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
      )
    ) {
      setError("A workspace member with this name already exists.");
      return;
    }
    const home = homes.find((item) => item.id === homeId);
    if (!home) {
      setError("Choose an agent home.");
      return;
    }
    const next = {
      id: editingId || crypto.randomUUID(),
      name: name.trim(),
      initials: agentInitials(name),
      instructions: instructions.trim(),
      description: instructions.trim(),
      runtime: home.kind,
      device: home.name,
      avatar,
      homeId,
      accessLevel,
      nameCustomized,
      modelConnection,
      paused,
      networkAccess,
    };
    if (!modelConnection) { setError("Choose a connected model."); return; }
    setSaving(true);
    try {
      await buzz.saveAgent(next);
      if (!editingId) setNewlyCreatedId(next.id);
      setDialogOpen(false);
      onNotify?.(editingId ? "Agent saved." : "Agent created.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save agent."); }
    finally { setSaving(false); }
  }
  const renderGrid = (group: readonly Agent[], kind: "local" | "cloud", home?: string) => (<div className="buzz-identity-grid" data-testid="unified-agents-groups">
        {admin && <button
          className="buzz-identity-card buzz-create-identity"
          aria-label={`New ${kind} agent`}
          onClick={() => homes.find(item=>item.id===home)?.modelCount===0 ? openModels(kind==='cloud'?'agents':'local') : openAgent(undefined, kind, home)}
        >
          <Plus size={28} /><span>{homes.find(item=>item.id===home)?.modelCount===0 ? kind==='cloud' ? 'Connect a cloud host' : 'Connect a local model' : 'New agent'}</span>
        </button>}
        {group.map((agent) => (
          <div
            className={`buzz-identity-card${agent.id === newlyCreatedId ? " agent-card-created" : ""}`}
            ref={agent.id === newlyCreatedId ? createdCard : undefined}
            key={agent.id}
          >
            <button
              className="buzz-identity-hit"
              aria-label={`${agent.name} agent profile`}
              onClick={() => admin ? openAgent(agent) : onNotify?.(`${agent.name}: ${agent.instructions || "Start a direct conversation from the sidebar."}`)}
            />
            <div className="buzz-identity-avatar">
              <div className="agent-card-portrait">
                <AgentAvatar identityKey={agent.id} character={agent.character || "octopus"} size={120} label={agent.name} />
                <AgentThinkingBubble name={agent.name} agentId={agent.id} />
              </div>
            </div>
            <div className="buzz-identity-footer">
              <strong className="agent-card-name">
                <span title={agent.name}>{agent.name}</span>
                {agent.runtime === "cloud" && <Cloud size={16} aria-label="Cloud" />}
              </strong>
              <small className="agent-card-clearance" aria-label={`Data access: ${agent.accessLevel}`}>{agent.accessLevel}{agent.paused ? ' / Paused' : ''}</small>
            </div>
          </div>
        ))}
      </div>);
  const preview = (group: readonly Agent[]) => group.slice(0,4).map(agent => <AgentAvatar key={agent.id} identityKey={agent.id} character={agent.character || "octopus"} label={agent.name} size={24} />);
  return (
    <div className="compute-agents-controller">
      <ComputeHomesView homes={homes.map(home => {
        const group = agents.filter(agent => agentHomeId(agent) === home.id);
        return {...home, agents:renderGrid(group, home.kind, home.id), count:group.length, preview:preview(group)};
      })} metrics={runtime?.metrics ?? null} onAddModels={() => openModels()} />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="agent-minimal-dialog">
          <DialogHeader className="sr-only">
            <DialogTitle>{editingId ? "Edit agent" : "Create agent"}</DialogTitle>
            <DialogDescription>Agent configuration</DialogDescription>
          </DialogHeader>
          <form
            className="agent-minimal-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAgent();
            }}
          >
            <div className="agent-editor-identity">
              <div className="agent-editor-avatar">
                <AgentAvatar avatar={avatar} size={128} label={name || "Agent"} preview />
                <button className="agent-avatar-edit" type="button" aria-label="Edit profile picture" title="Edit profile picture" disabled={saving || uploading} onClick={() => avatarInput.current?.click()}><Pencil size={15}/></button>
                <input ref={avatarInput} type="file" hidden aria-label="Upload agent picture" accept="image/png,image/jpeg,image/webp" disabled={saving || uploading} onChange={async event => {
              const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
              setUploading(true); setError('');
              try {
                if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP under 5 MB.');
                const bitmap = await createImageBitmap(file);
                try {
                  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                  const context = canvas.getContext('2d'); if (!context) throw new Error('This browser could not resize the image.');
                  const side = Math.min(bitmap.width, bitmap.height);
                  context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256);
                  const value = canvas.toDataURL('image/webp', 0.8);
                  if (value.length > 100000) throw new Error('Choose a simpler picture so it fits the profile size limit.');
                  setAvatar(value);
                } finally {bitmap.close();}
              } catch(error) {setError(error instanceof Error ? error.message : 'Could not read this picture.');}
              finally {setUploading(false);}
            }}/>
              </div>
              <input
                className="agent-editor-name"
                aria-label="Agent name"
                placeholder="Agent name"
                value={name}
                maxLength={60}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  setNameCustomized(true);
                }}
              />
            </div>
            <label className="field">
              <span className="field-label">Agent home</span>
              <select
                className="select"
                aria-label="Agent home"
                value={homeId}
                onChange={(event) => {
                  setHomeId(event.target.value);
                  setModelConnection('');
                  setAccessLevel(
                    homes.find((home) => home.id === event.target.value)?.kind === "cloud"
                      ? "Public"
                      : "Confidential",
                  );
                  setError("");
                }}
              >
                <option value="" disabled>
                  Choose a home
                </option>
                {homes.map((home) => (
                  <option key={home.id} value={home.id}>
                    {home.name}{home.status !== "connected" ? " / Not connected" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Access level</span>
              <select
                className="select"
                aria-label="Access level"
                value={accessLevel}
                onChange={(event) => setAccessLevel(event.target.value)}
              >
                {privacyLayers.map(({name:level}) => (
                  <option key={level}>{level}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select className="select" aria-label="Agent model" required disabled={!models.some(model => modelFitsHome(model, homeId))} value={modelConnection} onChange={event => setModelConnection(event.target.value)}><option value="" disabled>{models.some(model => modelFitsHome(model, homeId)) ? 'Choose a model' : 'No models connected'}</option>{models.filter(model => modelFitsHome(model, homeId)).map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select>
            </label>
            <label className="field">
              <span className="field-label">Instructions</span>
              <textarea
                className="textarea"
                aria-label="Agent instructions"
                rows={4}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="What should this agent do?"
              />
            </label>
            <details className="team-form">
              <summary>Execution settings</summary>
              <label className="agent-pause-control team-check"><input type="checkbox" checked={networkAccess} disabled={saving} onChange={event => setNetworkAccess(event.target.checked)} /> Allow network for commands</label>
              <small>Lets this agent install dependencies and access network services from its task directory when workspace network access is enabled. Only the assigned directory is mounted.</small>
            </details>
            {error && (
              <p role="alert" className="agents-form-error">
                {error}
              </p>
            )}
            {editingId && <label className="agent-pause-control"><input type="checkbox" checked={paused} disabled={saving} onChange={event => setPaused(event.target.checked)} /> Pause agent</label>}
            <DialogFooter className="agent-editor-actions">
              {editingId && <button type="button" className="btn agent-delete-button" disabled={saving} onClick={async () => { setSaving(true); try { await removeWorkspaceAgent(editingId); setDialogOpen(false); onNotify?.("Agent deleted."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete agent."); } finally { setSaving(false); } }}>Delete</button>}
              <button type="submit" className="btn btn-primary" disabled={saving || uploading || !name.trim() || !modelConnection}>
                {saving ? "Saving" : editingId ? "Save" : "Create"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
