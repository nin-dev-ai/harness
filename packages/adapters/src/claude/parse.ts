import type { AgentEvent, UsageSnapshot } from "@harness/core";
import { tryJson, type LineParser } from "../process.js";
import { summarizeInput, toIso } from "../cli-adapter.js";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const IGNORED = new Set(["user", "stream_event", "prompt_suggestion"]);
export const CLAUDE_LIMIT_PATTERN = /usage limit|rate limit|limit will reset|limit reached/i;

const WINDOW: Record<string, "5h" | "7d"> = { five_hour: "5h", seven_day: "7d" };

/** Window snapshots from a rate_limit_event (utilization 0–1, resetsAt unix seconds). */
export function claudeWindows(info: unknown, observedAt: string): UsageSnapshot[] {
  const uw = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined)?.unifiedWindows;
  if (!uw) return [];
  const out: UsageSnapshot[] = [];
  for (const [k, v] of Object.entries(uw)) {
    const kind = WINDOW[k];
    if (!kind || !v) continue;
    out.push({
      route: "",
      window: kind,
      usedPct: typeof v.utilization === "number" ? Math.round(v.utilization * 1000) / 10 : null,
      resetsAt: toIso(v.resetsAt) ?? null,
      source: "vendor",
      observedAt,
    });
  }
  return out;
}

/**
 * Stateful parser for `claude -p --output-format stream-json --verbose`.
 * `onWindows` receives usage snapshots from rate_limit_event lines.
 */
export function createClaudeParser(onWindows: (w: UsageSnapshot[]) => void = () => {}, now: () => Date = () => new Date()): LineParser {
  let limited = false;
  return (line, runId) => {
    if (line.stream === "stderr") {
      if (/No conversation found with session ID/i.test(line.line)) {
        return { events: [{ type: "error", runId, kind: "session_expired", message: line.line.trim(), retryable: false }] };
      }
      return { events: line.line.trim() ? [{ type: "message", runId, text: line.line, raw: { stream: "stderr" } }] : [] };
    }
    const o = tryJson(line.line) as Record<string, unknown> | undefined;
    if (!o || typeof o.type !== "string") return { events: line.line.trim() ? [{ type: "message", runId, text: line.line, raw: { unparsed: true } }] : [] };
    const sessionId = typeof o.session_id === "string" ? o.session_id : undefined;
    const events: AgentEvent[] = [];

    switch (o.type) {
      case "system":
        break;
      case "assistant": {
        const content = ((o.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === "text" && typeof c.text === "string" && c.text.trim()) events.push({ type: "message", runId, text: c.text });
          else if (c.type === "tool_use") {
            const name = String(c.name ?? "tool");
            events.push({ type: "tool_call", runId, tool: name, summary: summarizeInput(c.input) });
            const fp = (c.input as { file_path?: unknown; notebook_path?: unknown } | undefined)?.file_path ?? (c.input as { notebook_path?: unknown } | undefined)?.notebook_path;
            if (FILE_TOOLS.has(name) && typeof fp === "string") events.push({ type: "file_change", runId, path: fp });
          }
        }
        break;
      }
      case "rate_limit_event": {
        const info = o.rate_limit_info as Record<string, unknown> | undefined;
        onWindows(claudeWindows(info, now().toISOString()));
        if (info?.status === "rejected" && !limited) {
          limited = true;
          const kind = WINDOW[String(info.rateLimitType)] ?? "unknown";
          const resetsAt = toIso(info.resetsAt);
          events.push({ type: "rate_limit", runId, window: kind, ...(resetsAt ? { resetsAt } : {}) });
        }
        break;
      }
      case "result": {
        const usage = o.usage as Record<string, number> | undefined;
        if (usage || typeof o.total_cost_usd === "number") {
          events.push({
            type: "usage",
            runId,
            ...(usage ? { tokensIn: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), tokensOut: usage.output_tokens ?? 0 } : {}),
            ...(typeof o.total_cost_usd === "number" ? { costUsd: o.total_cost_usd } : {}),
          });
        }
        const text = typeof o.result === "string" ? o.result : "";
        const ok = o.is_error !== true && o.subtype === "success";
        if (!ok && !limited && CLAUDE_LIMIT_PATTERN.test(text)) {
          limited = true;
          events.push({ type: "rate_limit", runId, window: "unknown" });
        }
        let structured: unknown = o.structured_output;
        if (structured === undefined && text.trim().startsWith("{")) structured = tryJson(text);
        events.push({ type: "result", runId, ok, summary: text || String(o.subtype ?? ""), ...(structured !== undefined ? { structured } : {}) });
        break;
      }
      default:
        if (!IGNORED.has(o.type)) events.push({ type: "message", runId, text: `[${o.type}]`, raw: o });
    }
    return { events, ...(sessionId ? { sessionId } : {}) };
  };
}
