import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { CliExit, EXIT } from "../io.js";
import { openProject } from "./_client.js";

type LandReply =
  | { status: "landed"; mode: "fast-forward" | "merge"; commit: string; commits: number; into: string; from: string }
  | { status: "nothing" | "refused"; detail: string; into: string; from: string }
  | { status: "conflict"; files: string[]; into: string; from: string };

export function register(program: Command, ctx: Ctx): void {
  program
    .command("land")
    .description("Bring finished work from the integration branch into your base branch (fast-forward, or a merge commit)")
    .action(async () => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<LandReply>("land");
        if (ctx.json()) return ctx.printJson(r);
        if (r.status === "landed") ctx.print(`landed ${r.commits} commit${r.commits === 1 ? "" : "s"} from ${r.from} into ${r.into} (${r.mode}) at ${r.commit.slice(0, 10)}`);
        else if (r.status === "nothing") ctx.print(r.detail);
        else if (r.status === "conflict") throw new CliExit(EXIT.failed, `landing conflicts in: ${r.files.join(", ")}. Nothing was changed; merge ${r.from} by hand.`);
        else throw new CliExit(EXIT.failed, `not landed: ${r.detail}`);
      } finally {
        sess.close();
      }
    });
}
