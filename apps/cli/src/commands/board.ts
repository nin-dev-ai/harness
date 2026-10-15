import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("board")
    .description("Show the team board (.harness/HARNESS.md): what you asked for, who does what, what is done, agents' notes")
    .action(async () => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ file: string; text: string }>("board");
        if (ctx.json()) return ctx.printJson(r);
        ctx.print(r.text);
      } finally {
        sess.close();
      }
    });
}
