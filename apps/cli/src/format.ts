import type { StatusSnapshot, WindowView } from "@harness/daemon";

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const wrap = (on: boolean, a: number, b: number) => (s: string) => (on ? `\u001b[${a}m${s}\u001b[${b}m` : s);
export function style(color: boolean): Style {
  return { bold: wrap(color, 1, 22), dim: wrap(color, 2, 22), red: wrap(color, 31, 39), green: wrap(color, 32, 39), yellow: wrap(color, 33, 39), cyan: wrap(color, 36, 39) };
}

/** Plain text table with left-aligned columns. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths = all.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, visible(c).length)), []);
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i]! - visible(c).length))).join("  ").trimEnd()).join("\n");
}

// eslint-disable-next-line no-control-regex -- strip color codes for width
const visible = (s: string) => s.replace(/\u001b\[\d+m/g, "");

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function until(nowIso: string, iso: string | null): string {
  if (!iso) return "unknown";
  const t = new Date(iso);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} (${duration(t.getTime() - new Date(nowIso).getTime())})`;
}

export function bar(pct: number | null, width = 10): string {
  if (pct === null) return "?".repeat(width);
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(n) + "░".repeat(width - n);
}

/** One usage window: never shows unknown as 0. */
export function windowText(w: WindowView, now: string, s: Style): string {
  const tag = `[${w.source}]${w.stale ? " stale" : ""}`;
  const body = `${w.kind} ${bar(w.usedPct)} ${w.display.padStart(7)}${w.detail ? ` (${w.detail})` : ""}  resets ${until(now, w.resetsAt)}  ${w.capPct < 100 ? `cap ${w.capPct}%  ` : ""}${tag}`;
  return w.stale ? s.dim(body) : body;
}

export function formatStatus(snap: StatusSnapshot, s: Style): string {
  const out: string[] = [];
  out.push(`${s.bold(`harness · ${snap.project.name}`)}   mode: ${snap.project.autonomy} · scheduler: ${snap.scheduler.running ? s.green("running") : "stopped"} · burst: ${snap.scheduler.burst ? "ON" : "off"}`);
  out.push("", s.bold("USAGE"));
  for (const r of snap.routes) {
    const paused = r.pausedUntil ? s.yellow(` paused until ${until(snap.now, r.pausedUntil)}${r.pauseSource === "backoff" ? " (probing)" : ""}`) : "";
    out.push(`  ${r.route} (${r.vendor}, ${r.auth})${paused}`);
    if (!r.windows.some((w) => w.kind !== "budget")) out.push(`    usage unknown`);
    for (const w of r.windows) out.push(`    ${windowText(w, snap.now, s)}`);
  }
  out.push("", s.bold("WORKERS"));
  out.push(
    table(
      snap.workers.map((w) => [w.id, w.vendor, stateColor(w.state, s), w.taskId ? `${w.taskId} ${w.taskTitle ?? ""}` : w.waitingReason ? `waiting: ${w.waitingReason}` : "", duration(w.elapsedMs)]),
    ).replace(/^/gm, "  "),
  );
  out.push("", s.bold("TASKS"));
  const order = ["RUNNING", "GATING", "REPAIRING", "REVIEWING", "PAUSED", "NEEDS_HUMAN", "PR_READY", "QUEUED", "DRAFT", "STALE", "MERGED", "CANCELLED", "TAKEN_OVER"];
  const tasks = [...snap.tasks].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.id.localeCompare(b.id));
  if (!tasks.length) out.push("  (no tasks)");
  else
    out.push(
      table(
        tasks.map((t) => [t.id, stateColor(t.state, s), t.role, t.title, t.dependsOn.length ? `needs ${t.dependsOn.join(",")}` : "", t.blockedReason && t.state === "QUEUED" ? s.dim(`(${t.blockedReason})`) : t.needsHumanReason ? s.red(t.needsHumanReason) : ""]),
      ).replace(/^/gm, "  "),
    );
  if (snap.approvals.length) {
    out.push("", s.bold("APPROVALS"));
    for (const a of snap.approvals) out.push(`  ${a.id} ${a.taskId ?? ""} ${a.category}: ${a.context}`);
  }
  return out.join("\n");
}

export function stateColor(state: string, s: Style): string {
  if (["RUNNING", "GATING", "REPAIRING", "REVIEWING"].includes(state)) return s.cyan(state);
  if (["MERGED", "PR_READY"].includes(state)) return s.green(state);
  if (["NEEDS_HUMAN", "FAILED", "CANCELLED"].includes(state)) return s.red(state);
  if (["PAUSED", "WAITING", "STALE", "TAKEN_OVER"].includes(state)) return s.yellow(state);
  return state;
}
