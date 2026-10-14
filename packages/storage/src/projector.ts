import type { Database } from "better-sqlite3";
import type { HarnessEvent } from "@harness/core";

/** Tables derived from the event log. Clearing and replaying them must reproduce the same state. */
export const PROJECTION_TABLES = [
  "projects", "tasks", "workers", "runs", "check_results", "findings",
  "windows", "route_state", "cost_samples", "approvals",
] as const;

/**
 * Apply one event to the projection tables. Pure function of (current rows, event):
 * no clock reads, no randomness, so a replay produces identical rows.
 */
export function applyEvent(db: Database, e: HarnessEvent): void {
  const p = e.projectId;
  switch (e.type) {
    case "project.initialized":
      db.prepare("INSERT OR REPLACE INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)").run(p, e.payload.path, e.payload.name, e.ts);
      return;

    case "task.created":
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, role, state, size, depends_on, attempts, attempts_max, spec_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(e.taskId, p, e.payload.title, e.payload.role, e.payload.state, e.payload.size, JSON.stringify(e.payload.dependsOn), e.payload.attemptsMax, e.payload.specPath, e.ts, e.ts);
      return;

    case "task.state_changed":
      db.prepare("UPDATE tasks SET state = ?, blocked_reason = NULL, updated_at = ? WHERE project_id = ? AND id = ?").run(e.payload.to, e.ts, p, e.taskId);
      return;

    case "task.blocked":
      db.prepare("UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(e.payload.reason, e.ts, p, e.taskId);
      return;

    case "task.updated": {
      const f = e.payload.fields;
      const cols: [string, unknown][] = [];
      if (f.title !== undefined) cols.push(["title", f.title]);
      if (f.role !== undefined) cols.push(["role", f.role]);
      if (f.size !== undefined) cols.push(["size", f.size]);
      if (f.dependsOn !== undefined) cols.push(["depends_on", JSON.stringify(f.dependsOn)]);
      if (f.attempts !== undefined) cols.push(["attempts", f.attempts]);
      if (f.attemptsMax !== undefined) cols.push(["attempts_max", f.attemptsMax]);
      if (f.branch !== undefined) cols.push(["branch", f.branch]);
      if (f.worktree !== undefined) cols.push(["worktree", f.worktree]);
      if (!cols.length) return;
      db.prepare(`UPDATE tasks SET ${cols.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE project_id = ? AND id = ?`).run(...cols.map(([, v]) => v), e.ts, p, e.taskId);
      return;
    }

    case "worker.state_changed":
      db.prepare(
        `INSERT INTO workers (id, project_id, role, state, current_run, heartbeat_at, waiting_reason) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET role = excluded.role, state = excluded.state, current_run = excluded.current_run,
           heartbeat_at = excluded.heartbeat_at, waiting_reason = excluded.waiting_reason`,
      ).run(e.workerId, p, e.payload.role, e.payload.to, e.payload.currentRun ?? null, e.ts, e.payload.reason ?? null);
      return;

    case "run.started":
      db.prepare(
        `INSERT INTO runs (id, project_id, task_id, worker_id, route, vendor, model, kind, vendor_session_id, pid, state, started_at, artifact_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STARTING', ?, ?)`,
      ).run(e.runId, p, e.taskId, e.workerId, e.payload.route, e.payload.vendor, e.payload.model ?? null, e.payload.kind, e.payload.sessionId ?? null, e.payload.pid ?? null, e.ts, e.payload.artifactDir);
      return;

    case "run.event": {
      const ev = e.payload.event;
      if (ev.type === "started") {
        db.prepare("UPDATE runs SET state = 'RUNNING', pid = ?, vendor_session_id = COALESCE(?, vendor_session_id) WHERE id = ?").run(ev.pid, ev.sessionId ?? null, e.runId);
      }
      return;
    }

    case "run.taken_over":
      db.prepare("UPDATE runs SET state = 'TAKEN_OVER', vendor_session_id = COALESCE(?, vendor_session_id) WHERE id = ?").run(e.payload.sessionId ?? null, e.runId);
      return;

    case "run.finished":
      db.prepare(
        "UPDATE runs SET state = ?, ended_at = ?, exit_code = ?, error_kind = ?, vendor_session_id = COALESCE(?, vendor_session_id) WHERE id = ?",
      ).run(e.payload.state, e.ts, e.payload.exitCode, e.payload.errorKind ?? null, e.payload.sessionId ?? null, e.runId);
      return;

    case "run.crashed":
      db.prepare("UPDATE runs SET state = 'FAILED', error_kind = 'crashed', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(e.ts, e.runId);
      return;

    case "check.finished":
      db.prepare(
        "INSERT INTO check_results (run_id, check_id, ok, exit_code, duration_ms, signature, output_tail, required) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(e.runId, e.payload.checkId, e.payload.ok ? 1 : 0, e.payload.exitCode, e.payload.durationMs, e.payload.signature ?? null, e.payload.outputTail ?? null, e.payload.required === false ? 0 : 1);
      return;

    case "review.finding":
      db.prepare("INSERT INTO findings (run_id, severity, file, line, message) VALUES (?, ?, ?, ?, ?)").run(e.runId, e.payload.severity, e.payload.file ?? null, e.payload.line ?? null, e.payload.message);
      return;

    case "window.updated":
      db.prepare(
        `INSERT INTO windows (project_id, route, kind, used_pct, resets_at, source, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, route, kind) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at,
           source = excluded.source, observed_at = excluded.observed_at`,
      ).run(p, e.payload.route, e.payload.kind, e.payload.usedPct, e.payload.resetsAt, e.payload.source, e.ts);
      return;

    case "route.paused":
      db.prepare(
        `INSERT INTO route_state (project_id, route, paused_until, pause_source, paused_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, route) DO UPDATE SET paused_until = excluded.paused_until, pause_source = excluded.pause_source, paused_at = excluded.paused_at`,
      ).run(p, e.payload.route, e.payload.until, e.payload.source, e.ts);
      db.prepare("UPDATE windows SET paused_until = ? WHERE project_id = ? AND route = ?").run(e.payload.until, p, e.payload.route);
      return;

    case "route.resumed":
      db.prepare("UPDATE route_state SET paused_until = NULL, pause_source = NULL, paused_at = NULL WHERE project_id = ? AND route = ?").run(p, e.payload.route);
      db.prepare("UPDATE windows SET paused_until = NULL WHERE project_id = ? AND route = ?").run(p, e.payload.route);
      return;

    case "cost.sampled":
      db.prepare("INSERT INTO cost_samples (project_id, route, role, size, window_kind, delta_pct, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        p, e.payload.route, e.payload.role, e.payload.size, e.payload.windowKind, e.payload.deltaPct, e.runId ?? "", e.ts,
      );
      return;

    case "approval.requested":
      db.prepare("INSERT OR REPLACE INTO approvals (id, project_id, task_id, category, action, context, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)").run(
        e.payload.approvalId, p, e.taskId ?? null, e.payload.category, e.payload.action ?? null, e.payload.context, e.ts,
      );
      return;

    case "approval.granted":
      db.prepare("UPDATE approvals SET state = 'GRANTED', decided_at = ? WHERE project_id = ? AND id = ?").run(e.ts, p, e.payload.approvalId);
      return;

    case "approval.denied":
      db.prepare("UPDATE approvals SET state = 'DENIED', comment = ?, decided_at = ? WHERE project_id = ? AND id = ?").run(e.payload.comment ?? null, e.ts, p, e.payload.approvalId);
      return;

    default:
      // Events with no projection (dispatch.considered, check.started, ...) live only in the log.
      return;
  }
}
