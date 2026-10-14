import type { Command } from "commander";
import { taskIdArg, type Ctx } from "../ctx.js";
import { CliExit, EXIT } from "../io.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("approve [ids...]")
    .description("Approve draft tasks (T-004) or pending approvals (A-3) so they can proceed")
    .option("--all", "approve every draft task")
    .option("--deny", "deny the given approvals instead")
    .option("-m, --message <comment>", "comment for a denial")
    .action(async (ids: string[], o: { all?: boolean; deny?: boolean; message?: string }) => {
      if (!ids.length && !o.all) throw new CliExit(EXIT.usage, "give task ids, approval ids, or --all");
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const approvals = ids.filter((i) => /^A-\d+$/i.test(i)).map((i) => i.toUpperCase());
        const tasks = ids.filter((i) => !/^A-\d+$/i.test(i)).map(taskIdArg);
        for (const a of approvals) {
          await sess.call(o.deny ? "approval.deny" : "approval.grant", { id: a, ...(o.message ? { comment: o.message } : {}) });
          ctx.print(`${a} ${o.deny ? "denied" : "granted"}`);
        }
        if (tasks.length || o.all) {
          const r = await sess.call<{ approved: string[] }>("task.approve", o.all ? { all: true } : { ids: tasks });
          if (ctx.json()) ctx.printJson(r);
          else ctx.print(r.approved.length ? `approved: ${r.approved.join(", ")}` : "nothing to approve");
        }
      } finally {
        sess.close();
      }
    });
}
