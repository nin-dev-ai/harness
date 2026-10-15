import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("report")
    .description("What the latest request cost and who did it, per task and per subscription, plus the quality ledger")
    .option("--request <n>", "which request: -1 the latest (default), 0 the first", (v) => Number(v))
    .action(async (o: { request?: number }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ text: string }>("report", o.request !== undefined ? { index: o.request } : {});
        if (ctx.json()) return ctx.printJson(r);
        ctx.print(r.text);
      } finally {
        sess.close();
      }
    });
}
