import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { AgentEvent, HarnessEvent, Run } from "@harness/core";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

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

/** One log line per event of a run (agent events and the checks around them). */
export function formatRunEvent(e: HarnessEvent): string | undefined {
  const t = e.ts.slice(11, 19);
  if (e.type === "run.event") return `${t} ${formatAgentEvent(e.payload.event)}`;
  if (e.type === "check.finished") return `${t} ${e.payload.ok ? "✓" : "✗"} check ${e.payload.checkId} (${Math.round(e.payload.durationMs / 100) / 10}s)`;
  if (e.type === "run.finished") return `${t} run ${e.payload.state}`;
  if (e.type === "run.started") return `${t} run started on ${e.payload.route} (${e.payload.kind})`;
  return undefined;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("logs <runId>")
    .description("Print a run's normalized events, or its raw output")
    .option("--follow", "keep printing until the run finishes")
    .option("--raw", "print the raw event file from the run directory")
    .action(async (runId: string, o: { follow?: boolean; raw?: boolean }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ run: Run; events: HarnessEvent[]; artifactDir: string }>("logs", { runId });
        if (o.raw) {
          const f = path.join(r.artifactDir, "events.jsonl");
          ctx.print(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(no raw output)");
          return;
        }
        if (ctx.json()) return ctx.printJson(r.events);
        for (const e of r.events) {
          const line = formatRunEvent(e);
          if (line) ctx.print(line);
        }
        if (o.follow && !r.events.some((e) => e.type === "run.finished")) {
          const last = r.events.at(-1)?.seq ?? 0;
          await new Promise<void>((resolve) => {
            sess.client.onEvent((e) => {
              if (e.runId !== runId || (e.seq ?? 0) <= last) return;
              const line = formatRunEvent(e);
              if (line) ctx.print(line);
              if (e.type === "run.finished") resolve();
            });
            void sess.client.call("events.subscribe", { projectId: sess.projectId, runId, afterSeq: last });
            process.once("SIGINT", () => resolve());
          });
        }
      } finally {
        sess.close();
      }
    });
}
