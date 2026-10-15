import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addMs, type RunKind, type Task, type TaskSize, type UsageSnapshot } from "@harness/core";
import { capPct } from "@harness/config";
import { collect } from "@harness/adapters";
import {
  WEEKLY_COST_RATIO,
  fitsWindows,
  budgetLeft,
  currentUsed,
  estimateCost,
  fits,
  inQuietHours,
  jitterMs,
  parseQuietHours,
  periodStart,
  probeDelay,
  shouldReplace,
  usableHeadroom,
  type StoredWindow,
} from "@harness/quota";
import type { DispatchContext, Guard, GuardDecision } from "./guards.js";
import type { ProjectRuntime } from "./project.js";
import type { RunOutcome } from "./supervisor.js";
import { runEnv } from "./supervisor.js";

/** With no usage data and no manual budget, at most this many runs per route per rolling 5 hours. */
export const UNKNOWN_RUNS_PER_5H = 8;
const REFRESH_MS = 60_000;

interface StartSnapshot {
  used5h: number | null;
  used7d: number | null;
  resets5h: string | null;
  resets7d: string | null;
  startedMs: number;
  maxConcurrent: number;
}

export interface QuotaGuardOptions {
  kick: () => void;
  rng?: () => number;
  /** Account-level usage shared across projects (the daemon's), keyed by vendor and login. */
  account?: Map<string, UsageSnapshot[]>;
}

/**
 * Quota and burst rules (deterministic): would-not-fit, caps, weekly pacing,
 * manual budgets, quiet hours, pause per route on a limit, resume at the reset
 * with jitter, probe with backoff when the reset time is unknown.
 */
export class QuotaGuard implements Guard {
  readonly name = "quota";
  private lastRefresh = new Map<string, number>();
  private starts = new Map<string, StartSnapshot>();
  private probeAttempt = new Map<string, number>();
  private probing = new Set<string>();
  private timers = new Map<string, () => void>();
  private capReported = new Set<string>();

  constructor(
    private p: ProjectRuntime,
    private o: QuotaGuardOptions,
  ) {
    // A pause persisted before a restart still needs its wake-up.
    for (const route of Object.keys(p.config.routes)) {
      const rs = p.store.windows.routeState(p.id, route);
      if (rs.pausedUntil) this.wakeAt(route, rs.pausedUntil);
    }
    // Seed the account-level cache from what this project already knows, so it survives daemon restarts.
    const now = this.now();
    for (const [route, r] of Object.entries(p.config.routes)) {
      if (!o.account || r.vendor === "fake") continue;
      const key = `${r.vendor}|${r.auth}`;
      const known = p.store.windows.list(p.id, route).filter((w) => w.source === "vendor" && w.kind !== "budget" && (!w.resetsAt || new Date(w.resetsAt) > now));
      const have = o.account.get(key);
      if (known.length && (!have || known[0]!.observedAt > (have[0]?.observedAt ?? ""))) {
        o.account.set(key, known.map((w) => ({ route, window: w.kind as UsageSnapshot["window"], usedPct: w.usedPct, resetsAt: w.resetsAt, source: "vendor", observedAt: w.observedAt })));
      }
    }
  }

  async refreshRoutes(routes: string[]): Promise<void> {
    for (const r of routes) await this.refresh(r);
  }

  private now(): Date {
    return this.p.clock.now();
  }

  // ── windows ──────────────────────────────────────────────────────────

  windows(route: string): Map<string, StoredWindow> {
    return new Map(this.p.store.windows.list(this.p.id, route).map((w) => [w.kind, w]));
  }

  /** Pull the adapter's usage (at most once a minute unless forced) and record changes. */
  async refresh(route: string, force = false): Promise<void> {
    const nowMs = this.now().getTime();
    if (!force && nowMs - (this.lastRefresh.get(route) ?? -Infinity) < REFRESH_MS) return;
    this.lastRefresh.set(route, nowMs);
    let snaps: UsageSnapshot[] = [];
    try {
      snaps = await this.p.adapter(route).usage(route);
    } catch {
      return;
    }
    const r = this.p.config.routes[route];
    const key = r ? `${r.vendor}|${r.auth}` : undefined;
    if (key && this.o.account && r!.vendor !== "fake") {
      // What another project learned about this account counts here too.
      if (snaps.some((x) => x.source === "vendor")) this.o.account.set(key, snaps.filter((x) => x.source === "vendor"));
      else snaps = (this.o.account.get(key) ?? []).map((x) => ({ ...x, route }));
    }
    for (const s of snaps) this.record(route, { route, kind: s.window, usedPct: s.usedPct, resetsAt: s.resetsAt, source: s.source, observedAt: s.observedAt });
  }

  private record(route: string, next: StoredWindow): void {
    const cur = this.windows(route).get(next.kind);
    if (!shouldReplace(cur, next, this.now())) return;
    if (cur && cur.usedPct === next.usedPct && cur.resetsAt === next.resetsAt && cur.source === next.source) return;
    if (cur && next.source === "vendor" && cur.source !== "vendor" && cur.usedPct !== null && next.usedPct !== null && Math.abs(cur.usedPct - next.usedPct) > 10) {
      this.p.emit("window.discrepancy", { route, kind: next.kind, vendorPct: next.usedPct, tallyPct: cur.usedPct });
    }
    this.p.emit("window.updated", { route, kind: next.kind, usedPct: next.usedPct, resetsAt: next.resetsAt, source: next.source });
  }

  /** Manual budget usage for the current period, recorded as a `budget` window. */
  private budget(route: string): { usedPct: number; exhausted: boolean; detail: string } | undefined {
    const b = this.p.config.limits.routes[route]?.manual_budget;
    if (!b) return undefined;
    const now = this.now();
    const since = periodStart(now, b.per);
    const u = this.p.store.runs.usageSince(this.p.id, route, since.toISOString(), now.toISOString());
    let used = b.unit === "runs" ? u.runs : u.minutes;
    if (b.unit === "pct") {
      const samples = this.p.store.db
        .prepare("SELECT COALESCE(SUM(delta_pct), 0) FROM cost_samples WHERE project_id = ? AND route = ? AND window_kind = '5h' AND created_at >= ?")
        .pluck()
        .get(this.p.id, route, since.toISOString()) as number;
      used = samples;
    }
    const { usedPct, left } = budgetLeft({ unit: b.unit, amount: b.amount, used });
    const resetsAt = b.per === "5h" ? null : addMs(since, b.per === "day" ? 86_400_000 : 7 * 86_400_000);
    this.record(route, { route, kind: "budget", usedPct, resetsAt, source: "manual", observedAt: now.toISOString() });
    return { usedPct, exhausted: left <= 0, detail: `${used} of ${b.amount} ${b.unit}/${b.per} used (manual budget)` };
  }

  // ── dispatch ─────────────────────────────────────────────────────────

  private estimate(route: string, role: string, size: TaskSize, kind: "5h" | "7d" | "budget") {
    const samples = this.p.store.windows.costSamples(route, role, size, kind).map((s) => s.deltaPct).reverse();
    const cold = this.p.config.burst.cold_cost_pct;
    const defaults = kind === "7d" ? { S: cold.S * WEEKLY_COST_RATIO, M: cold.M * WEEKLY_COST_RATIO, L: cold.L * WEEKLY_COST_RATIO } : cold;
    return estimateCost(samples, size, defaults);
  }

  private roleFor(task: Task, kind: RunKind | string): string {
    return kind === "review" ? "reviewer" : task.role;
  }

  /** Reviews are read-only and short: estimated as size S until measured. */
  private sizeFor(task: Task, kind: RunKind | string): TaskSize {
    return kind === "review" ? "S" : task.size;
  }

  async canDispatch(ctx: DispatchContext): Promise<GuardDecision> {
    const { route, task } = ctx;
    const cfg = this.p.config;
    const now = this.now();

    const quiet = parseQuietHours(cfg.limits.quiet_hours);
    if (inQuietHours(now, quiet)) return { ok: false, reason: "policy", detail: `quiet hours ${cfg.limits.quiet_hours}` };

    const rs = this.p.store.windows.routeState(this.p.id, route);
    if (rs.pausedUntil && rs.pausedUntil <= now.toISOString()) {
      if (rs.pauseSource === "backoff") {
        void this.probe(route);
        return { ok: false, reason: "paused", detail: `route ${route}: resume time unknown, probing` };
      }
      this.p.emit("route.resumed", { route });
      this.probeAttempt.delete(route);
    }

    await this.refresh(route);
    const w = this.windows(route);
    const used5h = currentUsed(w.get("5h"), now);
    const used7d = currentUsed(w.get("7d"), now);
    const cap5h = capPct(cfg, route, "5h");
    const cap7d = capPct(cfg, route, "7d");
    const role = this.roleFor(task, ctx.kind);

    // Caps are hard ceilings, even when the vendor would allow more.
    for (const [kind, used, cap] of [["5h", used5h, cap5h], ["7d", used7d, cap7d]] as const) {
      if (used !== null && used >= cap) {
        const key = `${route}|${kind}|${w.get(kind)?.resetsAt ?? ""}`;
        if (!this.capReported.has(key)) {
          this.capReported.add(key);
          this.p.emit("budget.cap_reached", { route, kind, capPct: cap });
        }
        return { ok: false, reason: "window_exhausted", detail: `${route} ${kind} at ${used}% (cap ${cap}%)` };
      }
    }

    const budget = this.budget(route);
    if (budget?.exhausted) {
      const key = `${route}|budget|${periodStart(now, cfg.limits.routes[route]!.manual_budget!.per).toISOString()}`;
      if (!this.capReported.has(key)) {
        this.capReported.add(key);
        this.p.emit("budget.cap_reached", { route, kind: "budget", capPct: 100 });
      }
      return { ok: false, reason: "window_exhausted", detail: budget.detail };
    }

    const head = usableHeadroom({
      now, used5h, used7d, weeklyResetsAt: w.get("7d")?.resetsAt ?? null, cap5h, cap7d,
      safetyMarginPct: cfg.burst.safety_margin_pct, weeklyReservePct: cfg.burst.weekly_reserve_pct, quiet,
    });
    const size = this.sizeFor(task, ctx.kind);
    const est = this.estimate(route, role, size, "5h");

    if (head.usable !== null) {
      const inFlight = (kind: "5h" | "7d") =>
        ctx.liveOnRoute.reduce((sum, l) => {
          const t = this.p.store.tasks.get(this.p.id, l.taskId);
          return sum + (t ? this.estimate(route, this.roleFor(t, l.kind), this.sizeFor(t, l.kind), kind).p80 : 0);
        }, 0);
      const est7d = this.estimate(route, role, size, "7d");
      const fit = cfg.burst.enabled
        ? fitsWindows({ headroom5h: head.headroom5h, weeklyPerWindow: head.weeklyPerWindow, cost5h: est.p80, cost7d: est7d.p80, inFlight5h: inFlight("5h"), inFlight7d: inFlight("7d") })
        : head.usable <= 0
          ? fits(0, head.usable, 0)
          : ({ ok: true } as const);
      if (!fit.ok) return { ok: false, reason: fit.reason, detail: `${route} ${fit.detail}${est.cold ? " (cold estimate)" : ""}` };
    } else if (!budget) {
      const since = new Date(now.getTime() - 5 * 3_600_000).toISOString();
      const recent = this.p.store.runs.usageSince(this.p.id, route, since, now.toISOString()).runs;
      if (recent >= UNKNOWN_RUNS_PER_5H) return { ok: false, reason: "window_exhausted", detail: `${route}: usage unknown; ${recent} runs in the last 5h (conservative cap ${UNKNOWN_RUNS_PER_5H})` };
    }

    if (ctx.kind === "implement" && !this.isResume(task)) {
      const started = this.burstStarts(route);
      if (started >= cfg.limits.max_tasks_per_burst) return { ok: false, reason: "policy", detail: `max_tasks_per_burst (${cfg.limits.max_tasks_per_burst}) reached on ${route}` };
    }

    this.starts.set(task.id, {
      used5h, used7d, resets5h: w.get("5h")?.resetsAt ?? null, resets7d: w.get("7d")?.resetsAt ?? null,
      startedMs: now.getTime(), maxConcurrent: ctx.liveOnRoute.length + 1,
    });
    for (const l of ctx.liveOnRoute) {
      const s = this.starts.get(l.taskId);
      if (s) s.maxConcurrent = Math.max(s.maxConcurrent, ctx.liveOnRoute.length + 1);
    }
    return { ok: true };
  }

  private isResume(task: Task): boolean {
    return this.p.store.runs.listByTask(this.p.id, task.id).length > 0;
  }

  /** New tasks started on a route since this burst began (scheduler start or last route resume). */
  private burstStarts(route: string): number {
    const evs = this.p.store.events.list({ projectId: this.p.id, types: ["scheduler.changed", "route.resumed", "run.started"] });
    let n = 0;
    for (const e of evs) {
      if (e.type === "scheduler.changed" && e.payload.running) n = 0;
      else if (e.type === "route.resumed" && e.payload.route === route) n = 0;
      else if (e.type === "run.started" && e.payload.route === route && e.payload.kind === "initial") n++;
    }
    return n;
  }

  // ── after runs ───────────────────────────────────────────────────────

  async onRunFinished(p: ProjectRuntime, task: Task, route: string, kind: RunKind, outcome: RunOutcome): Promise<void> {
    const start = this.starts.get(task.id);
    this.starts.delete(task.id);
    if (!start) return;
    await this.refresh(route, true);
    const w = this.windows(route);
    const role = this.roleFor(task, kind);
    const env = { taskId: task.id, runId: outcome.runId };
    for (const [k, before, resets] of [["5h", start.used5h, start.resets5h], ["7d", start.used7d, start.resets7d]] as const) {
      const after = w.get(k);
      if (before === null || !after || after.usedPct === null || after.source !== "vendor") continue;
      if (resets && after.resetsAt && after.resetsAt !== resets) continue; // window reset mid-run: no clean sample
      const delta = Math.max(0, after.usedPct - before) / start.maxConcurrent;
      p.emit("cost.sampled", { route, role, size: this.sizeFor(task, kind), windowKind: k, deltaPct: Math.round(delta * 100) / 100 }, env);
    }
    if (p.config.limits.routes[route]?.manual_budget) {
      const minutes = (this.now().getTime() - start.startedMs) / 60_000;
      p.emit("cost.sampled", { route, role, size: this.sizeFor(task, kind), windowKind: "budget", deltaPct: Math.round(minutes * 100) / 100 }, env);
      this.budget(route);
    }
  }

  async onLimit(p: ProjectRuntime, route: string, outcome: RunOutcome): Promise<void> {
    const now = this.now();
    const rs = p.store.windows.routeState(p.id, route);
    if (rs.pausedUntil && rs.pausedUntil > now.toISOString()) return; // already paused: no duplicate pause
    const kind = outcome.rateLimit?.window ?? "unknown";
    const jitter = jitterMs(p.config.burst.resume_jitter_seconds, this.o.rng);
    let until: string | null = null;
    let source: "event" | "vendor" | "backoff" = "backoff";

    if (outcome.rateLimit?.resetsAt && outcome.rateLimit.resetsAt > now.toISOString()) {
      until = addMs(outcome.rateLimit.resetsAt, jitter);
      source = "event";
      if (kind !== "unknown") this.record(route, { route, kind, usedPct: 100, resetsAt: outcome.rateLimit.resetsAt, source: "inferred", observedAt: now.toISOString() });
    } else {
      await this.refresh(route, true);
      const w = this.windows(route);
      const candidates = (kind === "unknown" ? ["5h", "7d"] : [kind])
        .map((k) => w.get(k))
        .filter((x): x is StoredWindow => !!x && x.source === "vendor" && !!x.resetsAt && x.resetsAt > now.toISOString())
        .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0));
      if (candidates[0]?.resetsAt) {
        until = addMs(candidates[0].resetsAt, jitter);
        source = "vendor";
      }
    }
    if (!until) {
      const attempt = this.probeAttempt.get(route) ?? 0;
      until = new Date(now.getTime() + probeDelay(attempt)).toISOString();
      source = "backoff";
    }
    p.emit("route.paused", { route, until, source, window: kind });
    this.wakeAt(route, until);
  }

  private wakeAt(route: string, until: string): void {
    this.timers.get(route)?.();
    const ms = Math.max(0, new Date(until).getTime() - this.now().getTime());
    this.timers.set(route, this.p.clock.setTimeout(() => this.o.kick(), ms + 1));
  }

  /** A tiny low-cost request to see whether a route answers again. */
  private async probe(route: string): Promise<void> {
    if (this.probing.has(route)) return;
    this.probing.add(route);
    const attempt = this.probeAttempt.get(route) ?? 0;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-probe-"));
    let ok = false;
    try {
      const events = await collect(
        this.p.adapter(route).run({
          runId: `probe-${route}-${attempt + 1}`, cwd, prompt: "Reply with exactly: OK", mode: "readonly", allowedPaths: [],
          env: runEnv(this.p, route), timeoutMs: 120_000,
        }),
      );
      ok = events.some((e) => e.type === "result" && e.ok) && !events.some((e) => e.type === "rate_limit" || (e.type === "error" && (e.kind === "rate_limit" || e.kind === "quota_exhausted")));
    } catch {
      ok = false;
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      this.probing.delete(route);
    }
    if (ok) {
      this.p.emit("probe.sent", { route, ok: true, nextProbeAt: null });
      this.p.emit("route.resumed", { route });
      this.probeAttempt.delete(route);
    } else {
      const next = attempt + 1;
      this.probeAttempt.set(route, next);
      const until = new Date(this.now().getTime() + probeDelay(next)).toISOString();
      this.p.emit("probe.sent", { route, ok: false, nextProbeAt: until });
      this.p.emit("route.paused", { route, until, source: "backoff", window: "unknown" });
      this.wakeAt(route, until);
    }
    this.o.kick();
  }

  dispose(): void {
    for (const c of this.timers.values()) c();
  }
}
