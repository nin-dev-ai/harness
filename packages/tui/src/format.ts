import type { AgentEvent, HarnessEvent } from "@harness/core";

export function formatAgentEvent(e: AgentEvent): string {
  switch (e.type) {
    case "started": return `▶ started pid ${e.pid}${e.sessionId ? ` session ${e.sessionId}` : ""}`;
    case "message": return `› ${e.text}`;
    case "tool_call": return `› tool: ${e.tool} ${e.summary}`;
    case "file_change": return `› edit ${e.path}`;
    case "usage": return `· usage in=${e.tokensIn ?? "?"} out=${e.tokensOut ?? "?"}${e.costUsd !== undefined ? ` $${e.costUsd.toFixed(4)}` : ""}`;
    case "rate_limit": return `⏸ rate limit (${e.window})${e.resetsAt ? ` resets ${e.resetsAt}` : ""}`;
    case "result": return `${e.ok ? "✓" : "✗"} result: ${e.summary}`;
    case "error": return `✗ error (${e.kind}): ${e.message}`;
    case "exited": return `■ exited code ${e.code}${e.signal ? ` signal ${e.signal}` : ""}`;
  }
}

/** One plain line per event of a run (used by `harness logs`). */
export function formatRunEvent(e: HarnessEvent): string | undefined {
  if (e.type === "run.event") return formatAgentEvent(e.payload.event);
  if (e.type === "check.finished") return `${e.payload.ok ? "✓" : "✗"} check ${e.payload.checkId} (${Math.round(e.payload.durationMs / 100) / 10}s)`;
  if (e.type === "run.finished") return `■ run ${e.payload.state}`;
  if (e.type === "run.started") return `▶ run started on ${e.payload.route} (${e.payload.kind})`;
  if (e.type === "gate.passed") return "✓ gate passed";
  if (e.type === "gate.failed") return `✗ gate failed: ${e.payload.failed.join(", ")}`;
  return undefined;
}

export type EntryKind = "say" | "tool" | "edit" | "check" | "ok" | "err" | "warn" | "sys" | "you" | "run" | "finding";

/** One line in the chat-style stream. */
export interface Entry {
  kind: EntryKind;
  text: string;
  detail?: string;
  ts: string;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Claude-Code-style rendering of everything that happens on a task. */
export function toEntry(e: HarnessEvent): Entry | undefined {
  const ts = e.ts;
  switch (e.type) {
    case "run.started":
      return { kind: "run", text: `${e.payload.kind === "review" ? "review" : e.payload.kind} run on ${e.payload.route}`, detail: e.runId ?? "", ts };
    case "run.event": {
      const ev = e.payload.event;
      if (ev.type === "message") return { kind: "say", text: ev.text, ts };
      if (ev.type === "tool_call") return { kind: "tool", text: ev.tool, detail: ev.summary, ts };
      if (ev.type === "file_change") return { kind: "edit", text: ev.path, ts };
      if (ev.type === "result") return { kind: ev.ok ? "ok" : "err", text: ev.summary || (ev.ok ? "done" : "failed"), detail: "agent says", ts };
      if (ev.type === "error") return { kind: "err", text: `${ev.kind}: ${ev.message}`, ts };
      if (ev.type === "rate_limit") return { kind: "warn", text: `usage limit (${ev.window})${ev.resetsAt ? `, resets ${new Date(ev.resetsAt).toTimeString().slice(0, 5)}` : ""}`, ts };
      return undefined;
    }
    case "check.finished":
      return { kind: "check", text: `${e.payload.ok ? "✓" : "✗"} ${e.payload.checkId}`, detail: secs(e.payload.durationMs), ts };
    case "gate.passed":
      return { kind: "ok", text: "checks passed (run by harness, not the agent)", ts };
    case "gate.failed":
      return { kind: "err", text: `checks failed: ${e.payload.failed.join(", ")}`, ts };
    case "repair.requested":
      return { kind: "sys", text: `sending it back to the agent (attempt ${e.payload.attempt}, ${e.payload.cause})`, ts };
    case "stall.detected":
      return { kind: "err", text: `stalled: ${e.payload.detail ?? e.payload.reason}`, ts };
    case "review.finding":
      return { kind: "finding", text: e.payload.message, detail: `${e.payload.severity}${e.payload.file ? ` ${e.payload.file}${e.payload.line ? `:${e.payload.line}` : ""}` : ""}`, ts };
    case "review.passed":
      return { kind: "ok", text: `review passed (${e.payload.findings} finding${e.payload.findings === 1 ? "" : "s"})`, ts };
    case "review.blocked":
      return { kind: "err", text: `review found ${e.payload.blockers} blocker(s)`, ts };
    case "human.message":
      return { kind: "you", text: e.payload.text, ts };
    case "task.needs_human":
      return { kind: "err", text: `needs you: ${e.payload.reason}`, ts };
    case "branch.merged":
      return { kind: "ok", text: `merged into ${e.payload.into} 🎉`, ts };
    case "merge.conflict":
      return { kind: "err", text: `merge conflict in ${e.payload.files.join(", ")}`, ts };
    case "policy.denied":
      return { kind: "warn", text: `policy: ${e.payload.detail}`, ts };
    case "task.state_changed":
      return ["PAUSED", "QUEUED", "TAKEN_OVER", "STALE", "CANCELLED"].includes(e.payload.to) ? { kind: "sys", text: `${e.payload.to.toLowerCase()}${e.payload.reason ? ` · ${e.payload.reason}` : ""}`, ts } : undefined;
    default:
      return undefined;
  }
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** "14:05 (1h24m)" in local time, or "unknown". */
export function resetText(nowIso: string, iso: string | null): string {
  if (!iso) return "unknown";
  const t = new Date(iso);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} (${duration(t.getTime() - Date.parse(nowIso))})`;
}

export function bar(pct: number | null, width = 10): string {
  if (pct === null) return "·".repeat(width);
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}

export function clip(s: string, width: number): string {
  if (width <= 0) return "";
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}
