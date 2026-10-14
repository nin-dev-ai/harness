import type { AgentEvent } from "@harness/core";
import { tryJson, type LineParser } from "../process.js";

export const CODEX_LIMIT_PATTERN = /usage limit|rate limit|hit your limit|too many requests|quota/i;

/** "Try again in 1 hour 24 minutes" → ISO reset time, if present. */
export function parseRetryIn(message: string, now: Date = new Date()): string | undefined {
  const m = /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(message);
  if (!m || (!m[1] && !m[2])) return undefined;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  return new Date(now.getTime() + ms).toISOString();
}

/** Stateful parser for `codex exec --json`. A completed turn becomes the result. */
export function createCodexParser(now: () => Date = () => new Date()): LineParser {
  let lastMessage = "";
  let limited = false;
  let failed = false;
  return (line, runId) => {
    if (line.stream === "stderr") {
      const t = line.line.trim();
      if (/no rollout found for thread id|thread\/resume failed/i.test(t)) return { events: [{ type: "error", runId, kind: "session_expired", message: t, retryable: false }] };
      if (!t || /^Reading additional input from stdin/.test(t)) return { events: [] };
      return { events: [{ type: "message", runId, text: t, raw: { stream: "stderr" } }] };
    }
    const o = tryJson(line.line) as Record<string, unknown> | undefined;
    if (!o || typeof o.type !== "string") return { events: line.line.trim() ? [{ type: "message", runId, text: line.line, raw: { unparsed: true } }] : [] };
    const events: AgentEvent[] = [];
    switch (o.type) {
      case "thread.started":
        return { events, ...(typeof o.thread_id === "string" ? { sessionId: o.thread_id } : {}) };
      case "turn.started":
        break;
      case "item.started":
      case "item.completed": {
        const item = (o.item ?? {}) as Record<string, unknown>;
        if (item.type === "agent_message" && o.type === "item.completed" && typeof item.text === "string") {
          lastMessage = item.text;
          events.push({ type: "message", runId, text: item.text });
        } else if (item.type === "command_execution" && o.type === "item.started") {
          events.push({ type: "tool_call", runId, tool: "shell", summary: String(item.command ?? "") });
        } else if (item.type === "file_change" && o.type === "item.completed") {
          for (const ch of (item.changes as { path?: string }[] | undefined) ?? []) if (ch.path) events.push({ type: "file_change", runId, path: ch.path });
        } else if (item.type === "mcp_tool_call" && o.type === "item.started") {
          events.push({ type: "tool_call", runId, tool: String(item.tool ?? "mcp"), summary: String(item.server ?? "") });
        } else if (item.type === "error" && typeof item.message === "string") {
          events.push({ type: "message", runId, text: item.message, raw: item });
        }
        break;
      }
      case "turn.completed": {
        const u = (o.usage ?? {}) as Record<string, number>;
        events.push({ type: "usage", runId, tokensIn: u.input_tokens ?? 0, tokensOut: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) });
        if (!failed) events.push({ type: "result", runId, ok: true, summary: lastMessage, ...(lastMessage.trim().startsWith("{") ? { structured: tryJson(lastMessage) } : {}) });
        break;
      }
      case "error":
      case "turn.failed": {
        const msg = String((o.error as { message?: string } | undefined)?.message ?? o.message ?? "codex error");
        if (CODEX_LIMIT_PATTERN.test(msg)) {
          if (!limited) {
            limited = true;
            const resetsAt = parseRetryIn(msg, now());
            events.push({ type: "rate_limit", runId, window: "unknown", ...(resetsAt ? { resetsAt } : {}) });
          }
        } else if (o.type === "turn.failed" || !failed) {
          events.push({ type: "error", runId, kind: "unknown", message: msg, retryable: true });
        }
        failed = true;
        break;
      }
      default:
        events.push({ type: "message", runId, text: `[${o.type}]`, raw: o });
    }
    return { events };
  };
}
