import type { Command } from "commander";
import { taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  for (const verb of ["pause", "resume"] as const) {
    program
      .command(verb)
      .description(verb === "pause" ? "Pause a role, a task or everything (running work checkpoints first)" : "Resume a role, a task or the scheduler")
      .option("--role <role>")
      .option("--task <id>")
      .option("--all")
      .action(async (o: { role?: string; task?: string; all?: boolean }) => {
        const sess = await openProject(ctx.io, ctx.dir());
        try {
          const r = await sess.call<Record<string, string>>(verb, { ...(o.role ? { role: o.role } : {}), ...(o.task ? { task: taskIdArg(o.task) } : {}), ...(o.all ? { all: true } : {}) });
          ctx.print(`${verb === "pause" ? "paused" : "resumed"}: ${Object.values(r)[0]}`);
        } finally {
          sess.close();
        }
      });
  }
}
