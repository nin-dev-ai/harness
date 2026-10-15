import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

/** `harness tell "<message>"`: the chat box, for scripts and other terminals. */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("tell <message...>")
    .description("Tell the primary agent what to build or continue the current conversation")
    .option("--new", "start a separate conversation")
    .action(async (words: string[], o: { new?: boolean }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ summary: string; tasks: { id: string; title: string; role: string; dependsOn: string[] }[] }>("dispatch", { document: words.join(" "), source: "chat", newThread: Boolean(o.new) });
        if (ctx.json()) return ctx.printJson(r);
        if (r.summary) ctx.print(r.summary);
        for (const t of r.tasks) ctx.print(`  ${t.id} → ${t.role}: ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`);
        ctx.print(`${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} started. Follow along: harness watch <agent>, harness board`);
      } finally {
        sess.close();
      }
    });
}
