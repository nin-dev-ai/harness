import type { Command } from "commander";
import { taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";
import { attachFlow } from "../ui.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("attach <target>")
    .description("Take over a worker interactively (worker id like frontend-1, or a task id)")
    .action(async (target: string) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        await attachFlow(ctx, sess, /-\d+$/.test(target) && !/^t-/i.test(target) ? target : taskIdArg(target));
      } finally {
        sess.close();
      }
    });
}
