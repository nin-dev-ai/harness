import type { Database } from "better-sqlite3";
import type { TaskSize } from "@harness/core";

export interface WindowRow {
  route: string;
  kind: "5h" | "7d" | "budget";
  usedPct: number | null;
  resetsAt: string | null;
  source: "vendor" | "manual" | "inferred";
  observedAt: string;
  pausedUntil: string | null;
}

export interface RouteStateRow {
  route: string;
  pausedUntil: string | null;
  pauseSource: string | null;
  pausedAt: string | null;
}

export interface CostSampleRow {
  deltaPct: number;
  runId: string;
  createdAt: string;
}

export interface ApprovalRow {
  id: string; taskId: string | null; category: string; action: string | null; context: string;
  state: "PENDING" | "GRANTED" | "DENIED"; comment: string | null; createdAt: string; decidedAt: string | null;
}

/** Read access to windows, route pause state, cost samples and approvals. */
export class WindowsRepo {
  constructor(private db: Database) {}

  list(projectId: string, route?: string): WindowRow[] {
    const rows = (route
      ? this.db.prepare("SELECT * FROM windows WHERE project_id = ? AND route = ? ORDER BY route, kind").all(projectId, route)
      : this.db.prepare("SELECT * FROM windows WHERE project_id = ? ORDER BY route, kind").all(projectId)) as Record<string, unknown>[];
    return rows.map((r) => ({
      route: r.route as string, kind: r.kind as WindowRow["kind"], usedPct: r.used_pct as number | null, resetsAt: r.resets_at as string | null,
      source: r.source as WindowRow["source"], observedAt: r.observed_at as string, pausedUntil: r.paused_until as string | null,
    }));
  }

  routeState(projectId: string, route: string): RouteStateRow {
    const r = this.db.prepare("SELECT * FROM route_state WHERE project_id = ? AND route = ?").get(projectId, route) as Record<string, unknown> | undefined;
    return { route, pausedUntil: (r?.paused_until as string) ?? null, pauseSource: (r?.pause_source as string) ?? null, pausedAt: (r?.paused_at as string) ?? null };
  }

  costSamples(route: string, role: string, size: TaskSize, windowKind: string, limit = 50): CostSampleRow[] {
    return (this.db
      .prepare("SELECT delta_pct, run_id, created_at FROM cost_samples WHERE route = ? AND role = ? AND size = ? AND window_kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(route, role, size, windowKind, limit) as Record<string, unknown>[]).map((r) => ({ deltaPct: r.delta_pct as number, runId: r.run_id as string, createdAt: r.created_at as string }));
  }

  approvals(projectId: string, state?: ApprovalRow["state"]): ApprovalRow[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: r.id as string, taskId: r.task_id as string | null, category: r.category as string, action: r.action as string | null, context: r.context as string,
        state: r.state as ApprovalRow["state"], comment: r.comment as string | null, createdAt: r.created_at as string, decidedAt: r.decided_at as string | null,
      }))
      .filter((a) => !state || a.state === state);
  }
}
