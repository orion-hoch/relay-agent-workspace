import { buzz } from "@/lib/buzz/store";
import { AgentThinkingBubble } from "@/components/AgentThinkingBubble";
import {
  useAgentMembers,
  useWorkspaceMembers,
  removeWorkspaceAgent,
  type AgentMember as Agent,
} from "@/lib/workspace-members";
import { SelectField } from "@/components/SelectField";
// Identity-card layout adapted from block/buzz; see third-party notices.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, Database, Plus } from "lucide-react";
import { AgentAvatar, setAgentAvatarIdentity } from "@/components/AgentAvatar";
import { useAgentHomes } from "@/lib/agent-homes";
import { PageHeader } from "@/components/buzz/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
type AccessLevel = "Public" | "Internal" | "Confidential" | "Restricted";
const accessLevels: AccessLevel[] = ["Public", "Internal", "Confidential", "Restricted"];
import { AGENT_CHARACTERS, CHARACTER_NAMES, type AgentCharacter as Character } from '@/lib/agent-characters';
export type AgentHomeGroups = { localAgents: ReactNode; cloudAgents: ReactNode; localPreview: ReactNode; cloudPreview: ReactNode; localCount: number; cloudCount: number };
type Props = { onNotify?: (message: string) => void; onNavigate?: (view: string) => void; renderHomes?: (groups: AgentHomeGroups) => ReactNode };
const characters = AGENT_CHARACTERS;
const quirkyNames = CHARACTER_NAMES;
function generatedName(character: Character, existing: string[]) {
  const choices = quirkyNames[character];
  const base = choices[Math.floor(Math.random() * choices.length)];
  let candidate = base;
  let suffix = 2;
  while (existing.some((name) => name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) {
    candidate = `${base} ${suffix++}`;
  }
  return candidate;
}
export function AgentsView({ onNotify, renderHomes }: Props) {
  const homes = useAgentHomes();
  const agents = useAgentMembers();
  const members = useWorkspaceMembers();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameCustomized, setNameCustomized] = useState(false);
  const [character, setCharacter] = useState<Character>("octopus");
  const [homeId, setHomeId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("Confidential");
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
  function openAgent(agent?: Agent, preferredKind?: "local" | "cloud") {
    const nextCharacter =
      agent?.character || characters[Math.floor(Math.random() * characters.length)];
    setEditingId(agent?.id || null);
    setCharacter(nextCharacter);
    setName(
      agent?.name ||
        generatedName(
          nextCharacter,
          agents.map((item) => item.name),
        ),
    );
    setNameCustomized(agent?.nameCustomized ?? false);
    const initialHome =
      homes.find((home) => !agent && home.kind === preferredKind && home.status !== "pending") ||
      homes.find((home) => home.id === agent?.homeId) ||
      homes.find(
        (home) => agent && agent.device.startsWith(home.name) && home.kind === agent.runtime,
      ) ||
      homes.find((home) => home.kind === (agent?.runtime || "local") && home.status !== "pending");
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
    };
    window.addEventListener("relay:open-agent", onOpenAgent);
    return () => window.removeEventListener("relay:open-agent", onOpenAgent);
  });
  async function saveAgent() {
    if (saving) return;
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
    if (!home || home.status === "pending") {
      setError("Choose an agent home.");
      return;
    }
    const next = {
      id: editingId || crypto.randomUUID(),
      name: name.trim(),
      initials: name.trim().slice(0, 2),
      instructions: instructions.trim(),
      description: instructions.trim(),
      runtime: home.kind,
      device: home.name,
      character,
      homeId,
      accessLevel,
      nameCustomized,
    };
    setSaving(true);
    try {
      await buzz.saveAgent(next);
      if (!editingId) setNewlyCreatedId(next.id);
      setAgentAvatarIdentity(next.id, character);
      setDialogOpen(false);
      onNotify?.(editingId ? "Agent saved." : "Agent created.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save agent."); }
    finally { setSaving(false); }
  }
  const kindOf = (agent: Agent) => homes.find(home => home.id === agent.homeId)?.kind ?? agent.runtime;
  const local = agents.filter(agent => kindOf(agent) !== "cloud");
  const cloud = agents.filter(agent => kindOf(agent) === "cloud");
  const renderGrid = (group: readonly Agent[], kind: "local" | "cloud") => (<div className="buzz-identity-grid" data-testid="unified-agents-groups">
        <button
          className="buzz-identity-card buzz-create-identity"
          aria-label={`New ${kind} agent`}
          onClick={() => openAgent(undefined, kind)}
        >
          <Plus size={28} />
        </button>
        {group.map((agent) => (
          <div
            className={`buzz-identity-card agent-paper agent-paper-${agent.character || "octopus"}${agent.id === newlyCreatedId ? " agent-card-created" : ""}`}
            ref={agent.id === newlyCreatedId ? createdCard : undefined}
            key={agent.id}
          >
            <button
              className="buzz-identity-hit"
              aria-label={`${agent.name} agent profile`}
              onClick={() => openAgent(agent)}
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
                {agent.runtime === "cloud" ? (
                  <Cloud size={16} aria-label="Cloud" />
                ) : (
                  <Database size={16} aria-label="Local" />
                )}
              </strong>
              <small className="agent-card-clearance" aria-label={`Data access: ${agent.accessLevel}`}>{agent.accessLevel}</small>
            </div>
          </div>
        ))}
      </div>);
  const preview = (group: readonly Agent[]) => group.slice(0,4).map(agent => <AgentAvatar key={agent.id} identityKey={agent.id} character={agent.character || "octopus"} label={agent.name} size={24} />);
  return (
    <div className={renderHomes ? "compute-agents-controller" : "page agents-page buzz-agents-page"}>
      {renderHomes ? renderHomes({localAgents: renderGrid(local, "local"), cloudAgents: renderGrid(cloud, "cloud"), localPreview: preview(local), cloudPreview: preview(cloud), localCount: local.length, cloudCount: cloud.length}) : <><PageHeader className="page-heading" title="Agents" />{renderGrid(agents, "local")}</>}
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
                <AgentAvatar character={character} size={128} label={name || "Agent"} preview />
              </div>
              {(
                <div className="agent-avatar-choices" aria-label="Avatar choices">
                  {characters.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-label={`${value} avatar`}
                      aria-pressed={character === value}
                      onClick={() => {
                        setCharacter(value);
                        if (!nameCustomized)
                          setName(
                            generatedName(
                              value,
                              agents
                                .filter((item) => item.id !== editingId)
                                .map((item) => item.name),
                            ),
                          );
                      }}
                    >
                      <AgentAvatar character={value} size={48} label={value} preview />
                    </button>
                  ))}
                </div>
              )}
              <input
                className="agent-editor-name"
                aria-label="Agent name"
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
              <SelectField
                className="select"
                aria-label="Agent home"
                value={homeId}
                onChange={(event) => {
                  setHomeId(event.target.value);
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
                  <option key={home.id} value={home.id} disabled={home.status === "pending"}>
                    {home.name}
                    {home.status === "preview"
                      ? " · Not connected"
                      : home.status === "pending"
                        ? " · Pending"
                        : ""}
                  </option>
                ))}
              </SelectField>
            </label>
            <label className="field">
              <span className="field-label">Access level</span>
              <SelectField
                className="select"
                aria-label="Access level"
                value={accessLevel}
                onChange={(event) => setAccessLevel(event.target.value as AccessLevel)}
              >
                {accessLevels.map((level) => (
                  <option key={level}>{level}</option>
                ))}
              </SelectField>
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
            {error && (
              <p role="alert" className="agents-form-error">
                {error}
              </p>
            )}
            <DialogFooter>
              {editingId && <button type="button" className="agent-delete-button" disabled={saving} onClick={async () => { setSaving(true); try { await removeWorkspaceAgent(editingId); setDialogOpen(false); onNotify?.("Agent deleted."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete agent."); } finally { setSaving(false); } }}>Delete</button>}
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save" : "Create"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
