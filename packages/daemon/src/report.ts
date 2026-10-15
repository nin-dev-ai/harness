import type { Run, Task } from "@harness/core";
import type { ProjectRuntime } from "./project.js";

/**
 * What a request cost and who did it: per task and per subscription, from
 * the event log and run records. Numbers carry their source; tokens are what
 * vendors reported, usage percentages are measured window deltas.
 */

export interface TaskReportRow {
  id: string;
  title: string;
  role: string;
  state: string;
  attempts: number;
  runs: number;
  routes: string[];
  models: string[];
  activeMs: number;
  tokens: number;
}

export interface RouteTotals {
  route: string;
  vendor: string;
  runs: number;
  activeMs: number;
  tokens: number;
  /** Measured 5h-window delta in percent, when the vendor reports usage. */
  pct5h: number | null;
}

export interface RequestReport {
  request: string;
  startedAt: string;
  endedAt: string | null;
  wallMs: number | null;
  tasks: TaskReportRow[];
  routes: RouteTotals[];
  planning: { runs: number; activeMs: number; tokens: number };
  lead: string | undefined;
}

const ms = (r: Run) => (r.endedAt ? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime() : 0);

function tokensByRun(p: ProjectRuntime, runIds: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of runIds) {
    let total = 0;
    for (const e of p.store.events.list({ projectId: p.id, runId: id, types: ["run.event"] })) {
      const ev = (e.payload as { event?: { type?: string; tokensIn?: number; tokensOut?: number } }).event;
      if (ev?.type === "usage") total += (ev.tokensIn ?? 0) + (ev.tokensOut ?? 0);
    }
    out.set(id, total);
  }
  return out;
}

/** The report for one request: `index` counts from the newest (-1) or oldest (0). */
export function requestReport(p: ProjectRuntime, index = -1): RequestReport | undefined {
  const events = p.store.events.list({ projectId: p.id, types: ["team.request", "lead.reported", "plan.requested"] });
  const requests = events.filter((e) => e.type === "team.request");
  const req = requests.at(index);
  if (req?.type !== "team.request" || req.seq === undefined) return undefined;
  const next = requests[requests.indexOf(req) + 1];
  const inRange = (seq: number | undefined) => seq !== undefined && seq > req.seq! && (!next?.seq || seq < next.seq);
  const ids = [...req.payload.taskIds];
  let lead: string | undefined;
  for (const e of events) {
    if (e.type === "lead.reported" && inRange(e.seq)) {
      ids.push(...e.payload.followups);
      lead = e.payload.status;
    }
  }
  const tasks = new Map(p.tasks().map((t) => [t.id, t]));
  const runs = ids.flatMap((id) => p.store.runs.listByTask(p.id, id));
  // Planning and lead runs between this request and the next belong to it too.
  const pseudo = [...p.store.runs.listByTask(p.id, "PLAN"), ...p.store.runs.listByTask(p.id, "LEAD")].filter((r) => r.startedAt >= new Date(new Date(req.ts).getTime() - 120_000).toISOString() && (!next || r.startedAt < next.ts));
  const tokens = tokensByRun(p, new Set([...runs, ...pseudo].map((r) => r.id)));

  const rows: TaskReportRow[] = [];
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) continue;
    const mine = runs.filter((r) => r.taskId === id);
    rows.push({
      id, title: t.title, role: t.role, state: t.state, attempts: t.attempts, runs: mine.length,
      routes: [...new Set(mine.filter((r) => r.kind !== "review").map((r) => r.route))],
      models: [...new Set(mine.filter((r) => r.kind !== "review").map((r) => r.model ?? "default"))],
      activeMs: mine.reduce((a, r) => a + ms(r), 0),
      tokens: mine.reduce((a, r) => a + (tokens.get(r.id) ?? 0), 0),
    });
  }

  const pct = new Map<string, number>();
  const allRunIds = new Set([...runs, ...pseudo].map((r) => r.id));
  const samples = p.store.db.prepare("SELECT run_id AS runId, route, delta_pct AS delta FROM cost_samples WHERE project_id = ? AND window_kind = '5h'").all(p.id) as { runId: string; route: string; delta: number }[];
  for (const s of samples) if (allRunIds.has(s.runId)) pct.set(s.route, (pct.get(s.route) ?? 0) + s.delta);
  const byRoute = new Map<string, RouteTotals>();
  for (const r of [...runs, ...pseudo]) {
    const cur = byRoute.get(r.route) ?? { route: r.route, vendor: r.vendor, runs: 0, activeMs: 0, tokens: 0, pct5h: null };
    cur.runs++;
    cur.activeMs += ms(r);
    cur.tokens += tokens.get(r.id) ?? 0;
    cur.pct5h = pct.has(r.route) ? pct.get(r.route)! : cur.pct5h;
    byRoute.set(r.route, cur);
  }

  const ends = [...runs, ...pseudo].map((r) => r.endedAt).filter((x): x is string => !!x).sort();
  const settled = rows.length > 0 && rows.every((r) => ["MERGED", "NEEDS_HUMAN", "CANCELLED", "PR_READY"].includes(r.state));
  const endedAt = settled ? (ends.at(-1) ?? null) : null;
  return {
    request: req.payload.text, startedAt: req.ts, endedAt,
    wallMs: endedAt ? new Date(endedAt).getTime() - new Date(req.ts).getTime() + pseudo.filter((r) => r.startedAt < req.ts).reduce((a, r) => a + ms(r), 0) : null,
    tasks: rows,
    routes: [...byRoute.values()].sort((a, b) => b.activeMs - a.activeMs),
    planning: { runs: pseudo.length, activeMs: pseudo.reduce((a, r) => a + ms(r), 0), tokens: pseudo.reduce((a, r) => a + (tokens.get(r.id) ?? 0), 0) },
    lead,
  };
}

export interface QualityRow {
  vendor: string;
  tasks: number;
  merged: number;
  mergedWithin3: number;
  avgAttempts: number;
}

/**
 * The PRD's quality metric over this project's history: share of tasks that
 * reached MERGED within 3 attempts, by the vendor that implemented them.
 */
export function qualityLedger(p: ProjectRuntime): { rows: QualityRow[]; total: QualityRow } {
  const by = new Map<string, Task[]>();
  for (const t of p.tasks()) {
    if (t.state === "DRAFT" || t.state === "QUEUED" || t.state === "CANCELLED") continue;
    const first = p.store.runs.listByTask(p.id, t.id).find((r) => r.kind !== "review");
    if (!first) continue;
    by.set(first.vendor, [...(by.get(first.vendor) ?? []), t]);
  }
  const row = (vendor: string, ts: Task[]): QualityRow => ({
    vendor, tasks: ts.length,
    merged: ts.filter((t) => t.state === "MERGED").length,
    mergedWithin3: ts.filter((t) => t.state === "MERGED" && t.attempts <= 3).length,
    avgAttempts: ts.length ? Math.round((ts.reduce((a, t) => a + t.attempts, 0) / ts.length) * 10) / 10 : 0,
  });
  const rows = [...by.entries()].map(([v, ts]) => row(v, ts)).sort((a, b) => b.tasks - a.tasks);
  return { rows, total: row("all", [...by.values()].flat()) };
}

const dur = (n: number | null) => (n === null ? "—" : n < 60_000 ? `${Math.round(n / 1000)}s` : `${Math.floor(n / 60_000)}m${String(Math.round((n % 60_000) / 1000)).padStart(2, "0")}s`);
const tok = (n: number) => (n === 0 ? "—" : n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export function renderReport(r: RequestReport | undefined, q: { rows: QualityRow[]; total: QualityRow }): string {
  const out: string[] = [];
  if (!r) out.push("# Report", "", "No request yet: tell the team what to build.");
  else {
    out.push(`# Report · ${r.request.replace(/\s+/g, " ").slice(0, 100)}`, "", `${r.endedAt ? `Finished in ${dur(r.wallMs)}` : "Still running"} · ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} · planning and lead: ${r.planning.runs} run${r.planning.runs === 1 ? "" : "s"}, ${dur(r.planning.activeMs)}`, "");
    out.push("## Tasks");
    for (const t of r.tasks) out.push(`- ${t.id} ${t.title} · ${t.role} on ${t.routes.join("+") || "—"} (${t.models.join("+")}) · ${t.state.toLowerCase()} · attempt ${Math.max(1, t.attempts)} · ${dur(t.activeMs)} · ${tok(t.tokens)} tokens`);
    out.push("", "## By subscription");
    for (const x of r.routes) out.push(`- ${x.route} (${x.vendor}): ${x.runs} run${x.runs === 1 ? "" : "s"}, ${dur(x.activeMs)} working, ${tok(x.tokens)} tokens, 5h window ${x.pct5h === null ? "not measured" : `+${Math.round(x.pct5h * 10) / 10}%`}`);
    if (r.lead) out.push("", "## Lead", r.lead);
  }
  out.push("", "## Quality over this project (merged within 3 attempts)");
  if (!q.total.tasks) out.push("- no finished tasks yet");
  for (const x of [...q.rows, ...(q.rows.length > 1 ? [q.total] : [])]) out.push(`- ${x.vendor}: ${x.mergedWithin3}/${x.tasks} (${pctOf(x.mergedWithin3, x.tasks)}), ${x.avgAttempts} attempt${x.avgAttempts === 1 ? "" : "s"} on average`);
  out.push("", "_A one-agent baseline on the same tasks is not run automatically; compare against it before concluding the team is better._");
  return out.join("\n");
}
