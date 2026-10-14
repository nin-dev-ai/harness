import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { HarnessEvent, Task } from "@harness/core";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("export")
    .description("Write the event log and run records as JSONL")
    .option("--since <seq>", "only events after this sequence number", (v) => Number(v))
    .option("--out <file>", "write to a file instead of stdout")
    .action(async (o: { since?: number; out?: string }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const events = await sess.call<HarnessEvent[]>("events.list", { ...(o.since !== undefined ? { afterSeq: o.since } : {}) });
        const tasks = await sess.call<Task[]>("task.list");
        const runs: unknown[] = [];
        for (const t of tasks) {
          const r = await sess.call<{ runs: unknown[] }>("task.show", { id: t.id });
          runs.push(...r.runs);
        }
        const lines = [
          ...events.map((e) => JSON.stringify({ kind: "event", ...e })),
          ...tasks.map((t) => JSON.stringify({ kind: "task", ...t })),
          ...runs.map((r) => JSON.stringify({ kind: "run", ...(r as object) })),
        ].join("\n");
        if (o.out) {
          fs.writeFileSync(path.resolve(ctx.io.cwd, o.out), lines + "\n");
          ctx.io.err(`wrote ${events.length} events, ${tasks.length} tasks, ${runs.length} runs to ${o.out}`);
        } else ctx.print(lines);
      } finally {
        sess.close();
      }
    });
}
