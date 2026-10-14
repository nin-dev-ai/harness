import picomatchCompat from "./glob.js";
import type { BlockedReason, HarnessConfig, Task, TaskSize, Worker } from "@harness/core";

/** What a worker would do for a task. */
export type WorkKind = "implement" | "resume" | "repair" | "review";

export interface WorkItem {
  task: Task;
  kind: WorkKind;
  /** Role whose worker runs this item (the reviewer role for reviews). */
  role: string;
}

export interface SelectionInput {
  config: HarnessConfig;
  tasks: Task[];
  /** Tasks with a live run (any kind). */
  live: ReadonlySet<string>;
  /** Pause cause for PAUSED tasks: "limit" resumes automatically, "user" waits for `resume`. */
  pauseCause: (taskId: string) => "limit" | "user" | undefined;
  /** files_hint per task, for overlap checks. */
  filesHint: (taskId: string) => readonly string[];
  reviewerRole: string | undefined;
  /** Optional filters from `harness run --role/--task`. */
  onlyRole?: string | undefined;
  onlyTask?: string | undefined;
}

const SIZE_ORDER: Record<TaskSize, number> = { S: 0, M: 1, L: 2 };

/** Number of tasks that (transitively) depend on each task: finishing deep tasks unblocks the most. */
export function dependencyDepth(tasks: readonly Task[]): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  const memo = new Map<string, Set<string>>();
  const reach = (id: string, seen: Set<string>): Set<string> => {
    const m = memo.get(id);
    if (m) return m;
    const out = new Set<string>();
    for (const c of dependents.get(id) ?? []) {
      if (seen.has(c)) continue;
      out.add(c);
      for (const x of reach(c, new Set([...seen, c]))) out.add(x);
    }
    memo.set(id, out);
    return out;
  };
  return new Map(tasks.map((t) => [t.id, reach(t.id, new Set([t.id])).size]));
}

/** Every dependency is MERGED. */
export function depsMerged(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  return task.dependsOn.every((d) => byId.get(d)?.state === "MERGED");
}

/** Two sets of path globs/paths could touch the same file. */
export function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  for (const x of a) for (const y of b) if (x === y || picomatchCompat(x)(y) || picomatchCompat(y)(x)) return true;
  return false;
}

/**
 * Work that could run now, in priority order: in-flight work first (resumes
 * after a limit, repairs, reviews), then queued tasks by dependency depth,
 * then size (small first, to fill the tail of a window), then age.
 */
export function selectWork(i: SelectionInput): WorkItem[] {
  const byId = new Map(i.tasks.map((t) => [t.id, t]));
  const depth = dependencyDepth(i.tasks);
  const keep = (t: Task) => !i.live.has(t.id) && (!i.onlyTask || t.id === i.onlyTask) && (!i.onlyRole || t.role === i.onlyRole);
  const inflight: WorkItem[] = [];
  const queued: WorkItem[] = [];
  for (const t of i.tasks) {
    if (!keep(t)) continue;
    if (t.state === "PAUSED" && i.pauseCause(t.id) === "limit") inflight.push({ task: t, kind: "resume", role: t.role });
    else if (t.state === "REPAIRING") inflight.push({ task: t, kind: "repair", role: t.role });
    else if (t.state === "REVIEWING" && i.reviewerRole) inflight.push({ task: t, kind: "review", role: i.reviewerRole });
    else if (t.state === "QUEUED" && depsMerged(t, byId)) queued.push({ task: t, kind: "implement", role: t.role });
  }
  const order = (a: WorkItem, b: WorkItem) =>
    (depth.get(b.task.id) ?? 0) - (depth.get(a.task.id) ?? 0) ||
    SIZE_ORDER[a.task.size] - SIZE_ORDER[b.task.size] ||
    a.task.createdAt.localeCompare(b.task.createdAt) ||
    a.task.id.localeCompare(b.task.id);
  return [...inflight.sort(order), ...queued.sort(order)];
}

/** QUEUED tasks waiting on unmerged dependencies (reported as blocked: dependencies). */
export function waitingOnDeps(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.state === "QUEUED" && !depsMerged(t, byId));
}

/** A free worker for a role: idle or waiting, never paused, not running something. */
export function freeWorker(workers: readonly Worker[], role: string, busy: ReadonlySet<string>): Worker | undefined {
  return workers.find((w) => w.role === role && (w.state === "IDLE" || w.state === "WAITING") && !busy.has(w.id));
}

export interface Decision {
  dispatch: boolean;
  reason?: BlockedReason;
  detail?: string;
}
