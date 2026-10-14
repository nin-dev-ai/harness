import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { CliExit, EXIT } from "../io.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  const limits = program.command("limits").description("Caps and manual budgets per route");
  limits
    .command("set <route>")
    .description("Cap a window below the vendor's limit, or set a manual budget where no usage data exists")
    .requiredOption("--window <window>", "5h | 7d | budget")
    .requiredOption("--budget <value>", '"85%" for 5h/7d; "40 runs/day" or "120 minutes/week" for budget')
    .action(async (route: string, o: { window: string; budget: string }) => {
      if (!["5h", "7d", "budget"].includes(o.window)) throw new CliExit(EXIT.usage, "--window must be 5h, 7d or budget");
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call("limits.set", { route, window: o.window, budget: o.budget });
        if (ctx.json()) ctx.printJson(r);
        else ctx.print(`${route}: ${JSON.stringify(r)}`);
      } finally {
        sess.close();
      }
    });
}
