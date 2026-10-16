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
        // Never leave a request silently parked: if it cannot start, say why now.
        await new Promise((res) => setTimeout(res, 1500));
        const ids = new Set(r.tasks.map((t) => t.id));
        const last = new Map<string, { reason?: string; detail?: string }>();
        for (const id of ids) {
          const evs = await sess.call<{ type: string; payload: { reason?: string; detail?: string } }[]>("events.list", { taskId: id }).catch(() => []);
          const b = [...evs].reverse().find((e) => e.type === "task.blocked");
          if (b) last.set(id, b.payload);
        }
        const snap = await sess.call<{ tasks: { id: string; state: string }[] }>("status");
        for (const [id, b] of last) {
          if (snap.tasks.find((t) => t.id === id)?.state === "QUEUED") ctx.print(`  ${id} is waiting: ${b.detail ?? (b.reason ?? "").replace(/_/g, " ")}`);
        }
      } finally {
        sess.close();
      }
    });
}
