import type { Command } from "commander";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

/** `harness facts`: durable project facts every agent prompt carries. */
export function register(program: Command, ctx: Ctx): void {
  const facts = program.command("facts").description("Project facts every agent reads (conventions, how to run things, gotchas)");
  const show = (list: string[]) => ctx.print(list.length ? list.map((f, i) => `${i + 1}. ${f}`).join("\n") : "no project facts yet. Add one: harness facts add \"<fact>\"");
  const call = async (params: Record<string, unknown>) => {
    const sess = await openProject(ctx.io, ctx.dir());
    try {
      const r = await sess.call<{ facts: string[] }>("facts", params);
      if (ctx.json()) ctx.printJson(r);
      else show(r.facts);
    } finally {
      sess.close();
    }
  };
  facts.command("list", { isDefault: true }).description("List project facts").action(() => call({}));
  facts.command("add <fact...>").description("Add a fact").action((words: string[]) => call({ add: words.join(" ") }));
  facts.command("remove <number>").description("Remove a fact by its number").action((n: string) => call({ remove: Number(n) }));
}
