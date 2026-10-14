import type { Database } from "better-sqlite3";
import { WorkerSchema, type Worker } from "@harness/core";

interface WorkerRow {
  id: string; project_id: string; role: string; state: string; current_run: string | null; heartbeat_at: string | null; waiting_reason: string | null;
}

const toWorker = (r: WorkerRow): Worker =>
  WorkerSchema.parse({ id: r.id, projectId: r.project_id, role: r.role, state: r.state, currentRun: r.current_run, heartbeatAt: r.heartbeat_at, waitingReason: r.waiting_reason });

/** Read access to the workers projection. */
export class WorkersRepo {
  constructor(private db: Database) {}

  get(projectId: string, id: string): Worker | undefined {
    const r = this.db.prepare("SELECT * FROM workers WHERE project_id = ? AND id = ?").get(projectId, id) as WorkerRow | undefined;
    return r ? toWorker(r) : undefined;
  }

  list(projectId: string): Worker[] {
    return (this.db.prepare("SELECT * FROM workers WHERE project_id = ? ORDER BY role, id").all(projectId) as WorkerRow[]).map(toWorker);
  }
}
