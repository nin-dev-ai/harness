import type { AgentEvent } from "@harness/core";
import { tryJson, type LineParser } from "../process.js";
import { summarizeInput } from "../cli-adapter.js";

export const CURSOR_LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|limit reached/i;
const FILE_TOOLS = new Set(["edit", "write", "delete", "multiEdit", "searchReplace"]);
const IGNORED = new Set(["user", "thinking", "interaction_query"]);

/** Stateful parser for `cursor-agent -p --output-format stream-json`. */
export function createCursorParser(): LineParser {
  return (line, runId) => {
    if (line.stream === "stderr") {
      const t = line.line.trim();
      return { events: t ? [{ type: "message", runId, text: t, raw: { stream: "stderr" } }] : [] };
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
        const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
        if (text.trim()) events.push({ type: "message", runId, text });
        break;
      }
      case "tool_call": {
        if (o.subtype !== "started") break;
        const tc = (o.tool_call ?? {}) as Record<string, { args?: Record<string, unknown> }>;
        const key = Object.keys(tc).find((k) => k.endsWith("ToolCall")) ?? Object.keys(tc)[0] ?? "tool";
        const tool = key.replace(/ToolCall$/, "");
        const args = tc[key]?.args;
        events.push({ type: "tool_call", runId, tool, summary: summarizeInput(args) });
        if (FILE_TOOLS.has(tool) && typeof args?.path === "string") events.push({ type: "file_change", runId, path: args.path });
        break;
      }
      case "result": {
        const u = o.usage as Record<string, number> | undefined;
        if (u) events.push({ type: "usage", runId, tokensIn: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0), tokensOut: u.outputTokens ?? 0 });
        const text = typeof o.result === "string" ? o.result : "";
        const ok = o.is_error !== true && o.subtype === "success";
        if (!ok && CURSOR_LIMIT_PATTERN.test(text)) events.push({ type: "rate_limit", runId, window: "unknown" });
        events.push({ type: "result", runId, ok, summary: text, ...(text.trim().startsWith("{") ? { structured: tryJson(text) } : {}) });
        break;
      }
      default:
        if (!IGNORED.has(o.type)) events.push({ type: "message", runId, text: `[${o.type}]`, raw: o });
    }
    return { events, ...(sessionId ? { sessionId } : {}) };
  };
}
