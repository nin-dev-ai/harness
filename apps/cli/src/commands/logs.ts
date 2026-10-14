import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { HarnessEvent, Run } from "@harness/core";
import { formatRunEvent } from "@harness/tui";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

/** One log line per event of a run, with its time. */
function line(e: HarnessEvent): string | undefined {
  const l = formatRunEvent(e);
  return l ? `${e.ts.slice(11, 19)} ${l}` : undefined;
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
          const l = line(e);
          if (l) ctx.print(l);
        }
        if (o.follow && !r.events.some((e) => e.type === "run.finished")) {
          const last = r.events.at(-1)?.seq ?? 0;
          await new Promise<void>((resolve) => {
            sess.client.onEvent((e) => {
              if (e.runId !== runId || (e.seq ?? 0) <= last) return;
              const l = line(e);
              if (l) ctx.print(l);
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
