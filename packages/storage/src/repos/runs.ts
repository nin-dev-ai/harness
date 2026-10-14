import type { Database } from "better-sqlite3";
import { RunSchema, type Run } from "@harness/core";

interface RunRow {
  id: string; project_id: string; task_id: string; worker_id: string; route: string; vendor: string; model: string | null;
  kind: string; vendor_session_id: string | null; pid: number | null; state: string; started_at: string; ended_at: string | null;
  exit_code: number | null; error_kind: string | null; usage_delta_json: string | null; artifact_dir: string;
}

function toRun(r: RunRow): Run {
  return RunSchema.parse({
    id: r.id, projectId: r.project_id, taskId: r.task_id, workerId: r.worker_id, route: r.route, vendor: r.vendor, model: r.model,
    kind: r.kind, vendorSessionId: r.vendor_session_id, pid: r.pid, state: r.state, startedAt: r.started_at, endedAt: r.ended_at,
    exitCode: r.exit_code, errorKind: r.error_kind, usageDelta: r.usage_delta_json ? JSON.parse(r.usage_delta_json) : null, artifactDir: r.artifact_dir,
  });
}

export interface CheckResultRow {
  runId: string; checkId: string; ok: boolean; exitCode: number | null; durationMs: number | null;
  signature: string | null; outputTail: string | null; required: boolean;
}

export interface FindingRow {
  id: number; runId: string; severity: "blocker" | "major" | "nit"; file: string | null; line: number | null; message: string; resolved: boolean;
}

/** Read access to runs, check results and findings. */
export class RunsRepo {
  constructor(private db: Database) {}

  get(id: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return r ? toRun(r) : undefined;
  }

  listByTask(projectId: string, taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND task_id = ? ORDER BY started_at, rowid").all(projectId, taskId) as RunRow[]).map(toRun);
  }

  listActive(projectId?: string): Run[] {
    const sql = `SELECT * FROM runs WHERE state IN ('STARTING','RUNNING','PAUSED')${projectId ? " AND project_id = ?" : ""} ORDER BY started_at`;
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as RunRow[];
    return rows.map(toRun);
  }

  /** Next run number for a task (R-<task>-<n>). */
  nextNumber(projectId: string, taskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) FROM runs WHERE project_id = ? AND task_id = ?").pluck().get(projectId, taskId) as number) + 1;
  }

  latestForTask(projectId: string, taskId: string, kinds?: readonly string[]): Run | undefined {
    const runs = this.listByTask(projectId, taskId).filter((r) => !kinds || kinds.includes(r.kind));
    return runs.at(-1);
  }

  checkResults(runId: string): CheckResultRow[] {
    return (this.db.prepare("SELECT * FROM check_results WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[]).map((r) => ({
      runId: r.run_id as string, checkId: r.check_id as string, ok: r.ok === 1, exitCode: r.exit_code as number | null,
      durationMs: r.duration_ms as number | null, signature: r.signature as string | null, outputTail: r.output_tail as string | null, required: r.required === 1,
    }));
  }

  findings(runId: string): FindingRow[] {
    return (this.db.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number, runId: r.run_id as string, severity: r.severity as FindingRow["severity"], file: r.file as string | null,
      line: r.line as number | null, message: r.message as string, resolved: r.resolved === 1,
    }));
  }
}
