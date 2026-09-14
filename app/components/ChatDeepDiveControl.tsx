"use client";
import { useMemo } from "react";
import { GitBranch, ListTodo, Waves } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useWorkspaceMembers } from "@/lib/workspace-members";
import { useBuzz } from "@/lib/buzz/store";
import type { RunMode, RunRecord, RunStatus } from "@/lib/buzz/types";

export type ChatMode = RunMode | "task";

export function ChatDeepDiveControl({
  mode,
  onChange,
  disabled = false,
  taskAvailable = true,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  taskAvailable?: boolean;
  disabled?: boolean;
}) {
  return (
    <>
    <button
      type="button"
      className="chat-deep-dive-control"
      aria-label="Deep dive"
      aria-pressed={mode === "deep"}
      disabled={disabled}
      onClick={() => onChange(mode === "deep" ? "quick" : "deep")}
      title="Use a deeper research run for your next message"
    >
      <Waves size={15} />
      <span>Deep dive</span>
    </button>
    {taskAvailable && <button type="button" className="chat-deep-dive-control" aria-label="Task" aria-pressed={mode === "task"} disabled={disabled} onClick={() => onChange(mode === "task" ? "quick" : "task")}><ListTodo size={15}/><span>Task</span></button>}
    </>
  );
}
const active = new Set<RunStatus>(["queued", "preparing", "running", "awaiting"]);
const labels: Record<RunStatus, string> = {
  queued: "Waiting",
  preparing: "Preparing",
  running: "Working",
  awaiting: "Needs review",
  needs_input: "Needs input",
  paused: "Progress saved",
  completed: "Complete",
  failed: "Blocked",
  cancelled: "Cancelled",
};
const priority: Record<RunStatus, number> = {
  running: 7,
  awaiting: 6,
  preparing: 5,
  queued: 4,
  failed: 3,
  needs_input: 3,
  paused: 3,
  completed: 2,
  cancelled: 1,
};

/** The given roots plus their recorded subtasks, in a bounded cycle-safe breadth-first order. */
export function walkRuns(runs: readonly RunRecord[], roots: readonly RunRecord[]): RunRecord[] {
  const children = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (!run.parentRunId || run.kind !== "subtask") continue;
    const list = children.get(run.parentRunId) ?? [];
    list.push(run);
    children.set(run.parentRunId, list);
  }
  const result: RunRecord[] = [], seen = new Set<string>(), queue = roots.slice(0, 256);
  for (let index = 0; index < queue.length && result.length < 256; index++) {
    const run = queue[index];
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    result.push(run);
    for (const child of children.get(run.id) ?? [])
      if (!seen.has(child.id) && queue.length < 1024) queue.push(child);
  }
  return result;
}
/** Select a real room run and its recorded subtasks. */
export function selectDeepDiveRuns(runs: readonly RunRecord[], room: string): RunRecord[] {
  const roots = runs
    .filter((run) => run.room === room && run.mode === "deep" && run.kind !== "subtask")
    .sort(
      (a, b) =>
        Number(active.has(b.status)) - Number(active.has(a.status)) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const root = roots[0];
  if (!root) return [];
  return walkRuns(runs, root.triggerMessageId ? roots.filter(candidate => candidate.triggerMessageId === root.triggerMessageId) : [root]);
}

export function ChatDeepDiveActivity({ room }: { room: string }) {
  const { runs } = useBuzz();
  const members = useWorkspaceMembers();
  const tree = useMemo(() => selectDeepDiveRuns(runs, room), [runs, room]);
  const participants = useMemo(() => {
    const byAgent = new Map<string, RunRecord>();
    for (const run of tree) {
      const previous = byAgent.get(run.agentId);
      if (!previous || priority[run.status] > priority[previous.status])
        byAgent.set(run.agentId, run);
    }
    return [...byAgent.values()];
  }, [tree]);
  if (!tree.length) return null;
  const state = tree.some((run) => run.status === "awaiting")
    ? "Needs review"
    : tree.some((run) => run.status === "running")
      ? "Working"
      : tree.some((run) => run.status === "preparing")
        ? "Preparing"
        : tree.some((run) => run.status === "queued")
          ? "Waiting"
          : tree.some((run) => run.status === "failed")
            ? "Blocked"
            : labels[tree[0].status];
  return (
    <section className="chat-deep-dive-activity" aria-label="Deep dive activity">
      <div className="chat-deep-dive-summary">
        <GitBranch size={14} />
        <span>Deep dive</span>
        <output aria-live="polite" aria-atomic="true">
          {state} / {participants.length} {participants.length === 1 ? "agent" : "agents"}{tree.some(run=>run.kind==='subtask') ? ` / ${tree.filter(run=>run.kind==='subtask').length} workers` : ''}
        </output>
      </div>
      <div className="chat-deep-dive-participants" aria-label="Participating agents">
        {participants.map((run) => {
          const member = members.find((item) => item.id === run.agentId);
          const name = member?.name ?? run.agentId;
          return (
            <span
              className="chat-deep-dive-participant"
              key={run.agentId}
              title={`${name} / ${labels[run.status]}`}
              aria-label={`${name} / ${labels[run.status]}`}
            >
              {member?.kind === "agent" ? (
                <AgentAvatar
                  identityKey={member.id}
                  character={member.character}
                  label={name}
                  size={23}
                />
              ) : (
                <span className="chat-deep-dive-fallback" aria-hidden="true">
                  {name.slice(0, 2)}
                </span>
              )}

            </span>
          );
        })}
      </div>
    </section>
  );
}
