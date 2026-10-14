import { formatUsedPct, isStale, msBetween, type Task, type Worker } from "@harness/core";
import { capPct } from "@harness/config";
import type { ProjectRuntime } from "./project.js";
import type { ProjectEngine } from "./outer-loop.js";

export interface WindowView {
  route: string;
  vendor: string;
  kind: "5h" | "7d" | "budget";
  usedPct: number | null;
  display: string;
  resetsAt: string | null;
  source: "vendor" | "manual" | "inferred";
  observedAt: string;
  stale: boolean;
  capPct: number;
}

export interface RouteView {
  route: string;
  vendor: string;
  auth: string;
  model: string | null;
  pausedUntil: string | null;
  pauseSource: string | null;
  windows: WindowView[];
}

export interface WorkerView extends Worker {
  vendor: string;
  taskId: string | null;
  taskTitle: string | null;
  runKind: string | null;
  elapsedMs: number | null;
}

export interface StatusSnapshot {
  project: { id: string; name: string; root: string; integrationBranch: string; autonomy: string };
  scheduler: { running: boolean; until: string | null; burst: boolean };
  now: string;
  workers: WorkerView[];
  tasks: (Task & { needsHumanReason?: string | null })[];
  routes: RouteView[];
  approvals: { id: string; taskId: string | null; category: string; context: string }[];
  warnings: string[];
}

/** One consistent read of everything the UI and `status` show. */
export function snapshot(p: ProjectRuntime, engine: ProjectEngine): StatusSnapshot {
  const now = p.clock.now();
  const tasks = p.tasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const live = [...engine.live.values()];
  const workers: WorkerView[] = p.store.workers.list(p.id).map((w) => {
    const l = live.find((x) => x.workerId === w.id);
    const route = p.config.roles[w.role]?.route;
    return {
      ...w,
      vendor: route ? (p.config.routes[route]?.vendor ?? "?") : "?",
      taskId: l?.taskId ?? null,
      taskTitle: l ? (byId.get(l.taskId)?.title ?? null) : null,
      runKind: l?.kind ?? null,
      elapsedMs: l ? msBetween(l.startedAt, now) : null,
    };
  });
  const routes: RouteView[] = Object.entries(p.config.routes).map(([name, r]) => {
    const rs = p.store.windows.routeState(p.id, name);
    const windows = p.store.windows.list(p.id, name).map((w) => ({
      route: name,
      vendor: r.vendor,
      kind: w.kind,
      usedPct: w.usedPct,
      display: formatUsedPct(w.usedPct),
      resetsAt: w.resetsAt,
      source: w.source,
      observedAt: w.observedAt,
      stale: w.source !== "manual" && isStale(w.observedAt, now),
      capPct: capPct(p.config, name, w.kind),
    }));
    return { route: name, vendor: r.vendor, auth: r.auth, model: r.model ?? null, pausedUntil: rs.pausedUntil, pauseSource: rs.pauseSource, windows };
  });
  const needsHuman = new Map<string, string>();
  for (const e of p.store.events.list({ projectId: p.id, types: ["task.needs_human"] })) if (e.type === "task.needs_human" && e.taskId) needsHuman.set(e.taskId, e.payload.reason);
  return {
    project: { id: p.id, name: p.config.project, root: p.root, integrationBranch: p.config.integration_branch, autonomy: p.config.policy.autonomy },
    scheduler: { running: engine.running, until: engine.until, burst: p.config.burst.enabled },
    now: now.toISOString(),
    workers,
    tasks: tasks.map((t) => ({ ...t, needsHumanReason: t.state === "NEEDS_HUMAN" ? (needsHuman.get(t.id) ?? null) : null })),
    routes,
    approvals: p.store.windows.approvals(p.id, "PENDING").map((a) => ({ id: a.id, taskId: a.taskId, category: a.category, context: a.context })),
    warnings: p.warnings.map((w) => `${w.file ?? ""}${w.line ? `:${w.line}` : ""} ${w.message}`.trim()),
  };
}
