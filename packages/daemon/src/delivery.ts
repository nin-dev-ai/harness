import type { ProjectRuntime } from "./project.js";
import { git, isAncestor } from "@harness/workspace";

/** A task is delivered only when its merged commit is reachable from the base. */
export async function reconcileDelivery(p: ProjectRuntime): Promise<string[]> {
  const base = p.config.base_branch;
  const baseCommit = await git(p.root, ["rev-parse", base]);
  const delivered: string[] = [];
  for (const task of p.tasks(["MERGED"])) {
    const merge = p.store.events.list({ projectId: p.id, taskId: task.id, types: ["branch.merged"] }).at(-1);
    if (merge?.type !== "branch.merged" || p.store.events.exists(p.id, "task.delivered", task.id)) continue;
    if (!(await isAncestor(p.root, merge.payload.commit, base))) continue;
    p.emit("task.delivered", { into: base, commit: merge.payload.commit, baseCommit }, { taskId: task.id });
    delivered.push(task.id);
  }
  return delivered;
}

/** Event-backed projection; a merged task may still be waiting to land. */
export function taskDelivery(p: ProjectRuntime, taskId: string): "delivered" | "blocked" | "pending" {
  if (p.store.events.exists(p.id, "task.delivered", taskId)) return "delivered";
  const blocked = p.store.events.list({ projectId: p.id, taskId, types: ["land.blocked"] }).at(-1);
  return blocked ? "blocked" : "pending";
}
