import type { ProjectRuntime } from "./project.js";
import { taskDelivery } from "./delivery.js";

export interface ThreadTurn {
  threadId: string;
  text: string;
  taskId: string;
  previousTaskId?: string;
}

/** The event log owns threads; no second mutable conversation store is needed. */
export function threadTurns(p: ProjectRuntime, threadId?: string): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  for (const e of p.store.events.list({ projectId: p.id, types: ["thread.turn"] })) {
    if (e.type !== "thread.turn" || (threadId && e.payload.threadId !== threadId)) continue;
    turns.push({ threadId: e.payload.threadId, text: e.payload.text, taskId: e.payload.taskId, ...(e.payload.previousTaskId ? { previousTaskId: e.payload.previousTaskId } : {}) });
  }
  return turns;
}

export function threadForTask(p: ProjectRuntime, taskId: string): ThreadTurn | undefined {
  return threadTurns(p).find((turn) => turn.taskId === taskId);
}

export function previousTurn(p: ProjectRuntime, taskId: string): ThreadTurn | undefined {
  const turn = threadForTask(p, taskId);
  return turn?.previousTaskId ? threadForTask(p, turn.previousTaskId) : undefined;
}

export function priorRoute(p: ProjectRuntime, taskId: string): string | undefined {
  const prev = previousTurn(p, taskId);
  if (!prev) return undefined;
  return p.store.runs.listByTask(p.id, prev.taskId).filter((r) => r.kind !== "review" && r.kind !== "plan").at(-1)?.route;
}

/** Bounded semantic context when a new lane cannot resume the prior native session. */
export function threadHandoff(p: ProjectRuntime, taskId: string, maxChars = 8000): string {
  const turn = threadForTask(p, taskId);
  if (!turn) return "";
  const turns = threadTurns(p, turn.threadId);
  const older = turns.filter((t) => t.taskId !== taskId);
  const parts = ["## Conversation handoff", `Original request: ${turns[0]?.text ?? turn.text}`];
  for (const t of older.slice(-3)) {
    const run = p.store.runs.listByTask(p.id, t.taskId).filter((r) => r.kind !== "review").at(-1);
    const finished = run ? p.store.events.list({ projectId: p.id, runId: run.id, types: ["run.finished"] }).at(-1) : undefined;
    const summary = finished?.type === "run.finished" ? finished.payload.summary : undefined;
    const merged = p.store.events.list({ projectId: p.id, taskId: t.taskId, types: ["branch.merged"] }).at(-1);
    const files = merged?.type === "branch.merged" ? merged.payload.files ?? [] : [];
    parts.push(`Turn ${t.taskId}: ${t.text}`, `Result: ${summary ?? "no confirmed summary"}`, `Changed files: ${files.join(", ") || "none recorded"}`);
  }
  parts.push(`Current request: ${turn.text}`, "Use the current workspace as the source of truth. Recheck files and tests before changing them.");
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export interface ThreadStatus {
  id: string;
  primaryRole: string;
  state: "WORKING" | "WAITING" | "NEEDS_HUMAN" | "DELIVERED";
  taskIds: string[];
  reason: string | null;
}

export function threadStatuses(p: ProjectRuntime): ThreadStatus[] {
  const starts = new Map<string, string>();
  for (const e of p.store.events.list({ projectId: p.id, types: ["thread.started"] })) if (e.type === "thread.started") starts.set(e.payload.threadId, e.payload.primaryRole);
  const groups = new Map<string, ThreadTurn[]>();
  for (const turn of threadTurns(p)) groups.set(turn.threadId, [...(groups.get(turn.threadId) ?? []), turn]);
  return [...groups].map(([id, turns]) => {
    const task = p.task(turns.at(-1)!.taskId);
    const delivery = task.state === "MERGED" ? taskDelivery(p, task.id) : null;
    const lastBlock = p.store.events.list({ projectId: p.id, taskId: task.id, types: ["land.blocked", "task.blocked", "task.needs_human"] }).at(-1);
    const reason = lastBlock?.type === "land.blocked" || lastBlock?.type === "task.needs_human" ? lastBlock.payload.reason : lastBlock?.type === "task.blocked" ? lastBlock.payload.detail ?? lastBlock.payload.reason : null;
    const state = task.state === "MERGED" && delivery === "delivered" ? "DELIVERED" : task.state === "NEEDS_HUMAN" || delivery === "blocked" ? "NEEDS_HUMAN" : ["QUEUED", "PAUSED", "DRAFT", "STALE"].includes(task.state) || (task.state === "MERGED" && delivery !== "delivered") ? "WAITING" : "WORKING";
    return { id, primaryRole: starts.get(id) ?? task.role, state, taskIds: turns.map((t) => t.taskId), reason: state === "DELIVERED" ? null : reason };
  });
}
