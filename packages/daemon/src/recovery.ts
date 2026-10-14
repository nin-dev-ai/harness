import fs from "node:fs";
import path from "node:path";
import { canTransitionTask, type TaskState } from "@harness/core";
import { killGroup, processGroupAlive } from "@harness/adapters";
import { checkpoint } from "@harness/workspace";
import type { ProjectRuntime } from "./project.js";

const REQUEUE_FROM: readonly TaskState[] = ["RUNNING", "GATING", "REVIEWING", "REPAIRING"];

export interface RecoveryReport {
  crashedRuns: string[];
  requeued: string[];
  repaired: string[];
}

/**
 * Reconcile state after a daemon restart. Runs the previous daemon left open
 * are ended (their processes killed if still alive, since their output can no
 * longer be read), their worktrees checkpointed, and their tasks requeued to
 * resume. Tasks whose merge or PR already happened are never redone.
 */
export async function recoverProject(p: ProjectRuntime): Promise<RecoveryReport> {
  const report: RecoveryReport = { crashedRuns: [], requeued: [], repaired: [] };

  for (const run of p.store.runs.listActive(p.id)) {
    if (run.pid && processGroupAlive(run.pid)) await killGroup(run.pid, 1000);
    p.emit("run.crashed", { pid: run.pid, detail: "daemon restarted while the run was active" }, { taskId: run.taskId, runId: run.id, workerId: run.workerId });
    report.crashedRuns.push(run.id);
    const task = p.store.tasks.get(p.id, run.taskId);
    if (task?.worktree) {
      const wt = path.join(p.root, task.worktree);
      if (fs.existsSync(wt)) {
        try {
          const commit = await checkpoint(wt, task.id, run.id);
          p.emit("run.checkpointed", { commit, reason: "recovery" }, { taskId: task.id, runId: run.id });
        } catch {
          // A broken worktree is handled when the task is dispatched again.
        }
      }
    }
  }

  for (const t of p.tasks()) {
    // Never redo a merge: if the log says it merged, the task is MERGED.
    if (t.state !== "MERGED" && p.store.events.exists(p.id, "branch.merged", t.id)) {
      if (canTransitionTask(t.state, "MERGED")) p.transition(t.id, "MERGED", "recovered: merge already recorded");
      else p.emit("task.state_changed", { from: t.state, to: "MERGED", reason: "recovered: merge already recorded" }, { taskId: t.id });
      report.repaired.push(t.id);
      continue;
    }
    if (REQUEUE_FROM.includes(t.state)) {
      p.transition(t.id, "QUEUED", "recovered after daemon restart");
      report.requeued.push(t.id);
    }
  }

  for (const w of p.store.workers.list(p.id)) {
    if (w.state !== "IDLE" && w.state !== "PAUSED") p.setWorker(w.id, "IDLE", { reason: "recovered" });
  }

  if (report.crashedRuns.length || report.requeued.length || report.repaired.length) {
    p.emit("daemon.recovered", { requeued: report.requeued, crashedRuns: report.crashedRuns });
  }
  return report;
}
