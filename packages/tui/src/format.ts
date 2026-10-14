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

/** One line per event of a run: agent events and the checks around them. */
export function formatRunEvent(e: HarnessEvent): string | undefined {
  if (e.type === "run.event") return formatAgentEvent(e.payload.event);
  if (e.type === "check.finished") return `${e.payload.ok ? "✓" : "✗"} check ${e.payload.checkId} (${Math.round(e.payload.durationMs / 100) / 10}s)`;
  if (e.type === "run.finished") return `■ run ${e.payload.state}`;
  if (e.type === "run.started") return `▶ run started on ${e.payload.route} (${e.payload.kind})`;
  if (e.type === "gate.passed") return "✓ gate passed";
  if (e.type === "gate.failed") return `✗ gate failed: ${e.payload.failed.join(", ")}`;
  return undefined;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** "14:05 (1h24m)" in the viewer's local time, or "unknown". */
export function resetText(nowIso: string, iso: string | null): string {
  if (!iso) return "unknown";
  const t = new Date(iso);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} (${duration(t.getTime() - Date.parse(nowIso))})`;
}

export function bar(pct: number | null, width = 10): string {
  if (pct === null) return "·".repeat(width);
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(n) + "░".repeat(width - n);
}

export function clip(s: string, width: number): string {
  if (width <= 0) return "";
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}
