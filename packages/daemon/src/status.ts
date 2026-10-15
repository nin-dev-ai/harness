import { formatUsedPct, isStale, msBetween, type Task, type Worker } from "@harness/core";
import { capPct } from "@harness/config";
import { periodStart } from "@harness/quota";
import type { ProjectRuntime } from "./project.js";
import type { ProjectEngine } from "./outer-loop.js";

export interface WindowView {
  route: string;
  vendor: string;
  kind: "5h" | "7d" | "budget";
  usedPct: number | null;
  display: string;
  /** For manual budgets: "11 of 40 runs/day". */
  detail?: string;
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
  route: string | null;
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
  tasks: (Task & { needsHumanReason?: string | null; lastRunId?: string | null })[];
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
    // A pooled role shows the route it is running on right now.
    const route = l?.route ?? p.config.roles[w.role]?.route;
    return {
      ...w,
      vendor: route ? (p.config.routes[route]?.vendor ?? "?") : "?",
      route: route ?? null,
      taskId: l?.taskId ?? null,
      taskTitle: l ? (byId.get(l.taskId)?.title ?? null) : null,
      runKind: l?.kind ?? null,
      elapsedMs: l ? msBetween(l.startedAt, now) : null,
    };
  });
  const routes: RouteView[] = Object.entries(p.config.routes).map(([name, r]) => {
    const rs = p.store.windows.routeState(p.id, name);
    const budget = p.config.limits.routes[name]?.manual_budget;
    const windows: WindowView[] = p.store.windows.list(p.id, name).filter((w) => w.kind !== "budget" || !budget).map((w) => ({
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
    if (budget) {
      // Computed fresh from runs in the period, so it shows before anything has run.
      const since = periodStart(now, budget.per);
      const u = p.store.runs.usageSince(p.id, name, since.toISOString(), now.toISOString());
      const used = budget.unit === "runs" ? u.runs : budget.unit === "minutes" ? u.minutes : 0;
      const pct = Math.round((used / budget.amount) * 1000) / 10;
      windows.push({
        route: name, vendor: r.vendor, kind: "budget", usedPct: pct, display: formatUsedPct(pct), detail: `${used} of ${budget.amount} ${budget.unit}/${budget.per}`,
        resetsAt: budget.per === "5h" ? null : new Date(since.getTime() + (budget.per === "day" ? 86_400_000 : 7 * 86_400_000)).toISOString(),
        source: "manual", observedAt: now.toISOString(), stale: false, capPct: 100,
      });
    }
    // Tiered routes show their tiers, e.g. "S haiku · L opus".
    const tiers = r.models ? Object.entries(r.models).map(([k, v]) => `${k} ${v}`).join(" · ") : "";
    return { route: name, vendor: r.vendor, auth: r.auth, model: tiers || (r.model ?? null), pausedUntil: rs.pausedUntil, pauseSource: rs.pauseSource, windows };
  });
  const needsHuman = new Map<string, string>();
  for (const e of p.store.events.list({ projectId: p.id, types: ["task.needs_human"] })) if (e.type === "task.needs_human" && e.taskId) needsHuman.set(e.taskId, e.payload.reason);
  return {
    project: { id: p.id, name: p.config.project, root: p.root, integrationBranch: p.config.integration_branch, autonomy: p.config.policy.autonomy },
    scheduler: { running: engine.running, until: engine.until, burst: p.config.burst.enabled },
    now: now.toISOString(),
    workers,
    tasks: tasks.map((t) => ({ ...t, needsHumanReason: t.state === "NEEDS_HUMAN" ? (needsHuman.get(t.id) ?? null) : null, lastRunId: p.store.runs.listByTask(p.id, t.id).at(-1)?.id ?? null })),
    routes,
    approvals: p.store.windows.approvals(p.id, "PENDING").map((a) => ({ id: a.id, taskId: a.taskId, category: a.category, context: a.context })),
    warnings: p.warnings.map((w) => `${w.file ?? ""}${w.line ? `:${w.line}` : ""} ${w.message}`.trim()),
  };
}
