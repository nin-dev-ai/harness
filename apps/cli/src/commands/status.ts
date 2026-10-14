import type { Command } from "commander";
import type { StatusSnapshot } from "@harness/daemon";
import { formatStatus } from "../format.js";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("status")
    .description("Print workers, tasks and windows (--json is stable for scripts)")
    .option("--watch", "keep printing as things change")
    .action(async (o: { watch?: boolean }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      const show = async () => {
        const snap = await sess.call<StatusSnapshot>("status");
        if (ctx.json()) ctx.printJson(snap);
        else ctx.print(`${o.watch ? "\u001b[2J\u001b[H" : ""}${formatStatus(snap, ctx.s())}`);
      };
      if (!o.watch) {
        try {
          await show();
        } finally {
          sess.close();
        }
        return;
      }
      await show();
      let timer: NodeJS.Timeout | undefined;
      sess.client.onEvent(() => {
        timer ??= setTimeout(() => {
          timer = undefined;
          void show();
        }, 300);
      });
      await sess.client.call("events.subscribe", { projectId: sess.projectId });
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      sess.close();
    });
}
