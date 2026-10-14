import type { Database } from "better-sqlite3";
import { HarnessEventSchema, type EventType, type HarnessEvent } from "@harness/core";

interface EventRow {
  seq: number; ts: string; project_id: string; type: string; task_id: string | null; run_id: string | null; worker_id: string | null; payload: string;
}

export function rowToEvent(r: EventRow): HarnessEvent {
  return HarnessEventSchema.parse({
    seq: r.seq, ts: r.ts, projectId: r.project_id, type: r.type, taskId: r.task_id, runId: r.run_id, workerId: r.worker_id, payload: JSON.parse(r.payload),
  });
}

export interface EventQuery {
  projectId?: string;
  afterSeq?: number;
  taskId?: string;
  runId?: string;
  types?: readonly EventType[];
  limit?: number;
}

/** Read access to the append-only event log. */
export class EventsRepo {
  constructor(private db: Database) {}

  list(q: EventQuery = {}): HarnessEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.projectId) {
      where.push("project_id = ?");
      args.push(q.projectId);
    }
    if (q.afterSeq !== undefined) {
      where.push("seq > ?");
      args.push(q.afterSeq);
    }
    if (q.taskId) {
      where.push("task_id = ?");
      args.push(q.taskId);
    }
    if (q.runId) {
      where.push("run_id = ?");
      args.push(q.runId);
    }
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`);
      args.push(...q.types);
    }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ${q.limit ? "LIMIT " + Math.floor(q.limit) : ""}`;
    return (this.db.prepare(sql).all(...args) as EventRow[]).map(rowToEvent);
  }

  lastSeq(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) FROM events").pluck().get() as number) ?? 0;
  }

  exists(projectId: string, type: EventType, taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE project_id = ? AND type = ? AND task_id = ? LIMIT 1").get(projectId, type, taskId));
  }
}
