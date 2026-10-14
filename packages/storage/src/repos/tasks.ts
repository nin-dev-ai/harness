import type { Database } from "better-sqlite3";
import { TaskSchema, type Task, type TaskState } from "@harness/core";

interface TaskRow {
  id: string; project_id: string; title: string; role: string; state: string; size: string; depends_on: string;
  attempts: number; attempts_max: number; branch: string | null; worktree: string | null; spec_path: string;
  blocked_reason: string | null; created_at: string; updated_at: string;
}

function toTask(r: TaskRow): Task {
  return TaskSchema.parse({
    id: r.id, projectId: r.project_id, title: r.title, role: r.role, state: r.state, size: r.size,
    dependsOn: JSON.parse(r.depends_on), attempts: r.attempts, attemptsMax: r.attempts_max, branch: r.branch,
    worktree: r.worktree, specPath: r.spec_path, blockedReason: r.blocked_reason, createdAt: r.created_at, updatedAt: r.updated_at,
  });
}

/** Read access to the tasks projection. */
export class TasksRepo {
  constructor(private db: Database) {}

  get(projectId: string, id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id) as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }

  list(projectId: string, states?: readonly TaskState[]): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id").all(projectId) as TaskRow[];
    const tasks = rows.map(toTask);
    return states ? tasks.filter((t) => states.includes(t.state)) : tasks;
  }

  ids(projectId: string): string[] {
    return this.db.prepare("SELECT id FROM tasks WHERE project_id = ?").pluck().all(projectId) as string[];
  }
}
