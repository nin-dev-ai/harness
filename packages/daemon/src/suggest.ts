import type { ProjectRuntime } from "./project.js";

export interface RouteStats {
  role: string;
  route: string;
  finished: number;
  mergedWithin3: number;
  rate: number;
  avgAttempts: number;
  costUsd: number | null;
}

export interface Suggestion {
  role: string;
  current: string;
  suggested: string | null;
  reason: string;
  stats: RouteStats[];
}

/** Minimum finished tasks on a route before it counts as evidence. */
export const MIN_SAMPLES = 3;

/**
 * Adaptive routing suggestions from the run history (FR-22). Explains each
 * recommendation with the recorded numbers; never changes a role itself.
 */
export function suggestRoutes(p: ProjectRuntime): Suggestion[] {
  const stats = new Map<string, RouteStats>();
  for (const t of p.tasks()) {
    if (t.state !== "MERGED" && t.state !== "NEEDS_HUMAN") continue;
    const runs = p.store.runs.listByTask(p.id, t.id).filter((r) => r.kind !== "review" && r.kind !== "plan");
    const route = runs[0]?.route;
    if (!route) continue;
    const key = `${t.role}|${route}`;
    const s = stats.get(key) ?? { role: t.role, route, finished: 0, mergedWithin3: 0, rate: 0, avgAttempts: 0, costUsd: null };
    s.avgAttempts = (s.avgAttempts * s.finished + t.attempts) / (s.finished + 1);
    s.finished++;
    if (t.state === "MERGED" && t.attempts <= 3) s.mergedWithin3++;
    for (const e of p.store.events.list({ projectId: p.id, taskId: t.id, types: ["run.event"] })) {
      if (e.type === "run.event" && e.payload.event.type === "usage" && e.payload.event.costUsd !== undefined) s.costUsd = (s.costUsd ?? 0) + e.payload.event.costUsd;
    }
    s.rate = Math.round((s.mergedWithin3 / s.finished) * 100);
    stats.set(key, s);
  }
  const out: Suggestion[] = [];
  for (const [role, cfg] of Object.entries(p.config.roles)) {
    if (cfg.mode !== "write") continue;
    const rows = [...stats.values()].filter((s) => s.role === role).sort((a, b) => b.rate - a.rate || a.avgAttempts - b.avgAttempts);
    const current = rows.find((r) => r.route === cfg.route);
    const best = rows.find((r) => r.finished >= MIN_SAMPLES);
    let suggested: string | null = null;
    let reason: string;
    if (!current || current.finished < MIN_SAMPLES) reason = `not enough history on ${cfg.route} yet (${current?.finished ?? 0} finished tasks, need ${MIN_SAMPLES})`;
    else if (best && best.route !== cfg.route && best.rate >= current.rate + 20) {
      suggested = best.route;
      reason = `${best.route} merged ${best.rate}% of ${best.finished} ${role} tasks within 3 attempts vs ${current.rate}% of ${current.finished} on ${cfg.route}`;
    } else reason = `keep ${cfg.route}: ${current.rate}% of ${current.finished} tasks merged within 3 attempts`;
    out.push({ role, current: cfg.route, suggested, reason, stats: rows });
  }
  return out;
}
