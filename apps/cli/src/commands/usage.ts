import type { Command } from "commander";
import type { RouteView } from "@harness/daemon";
import { windowText } from "../format.js";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("usage")
    .description("Show every window per route, with source, freshness and reset time")
    .action(async () => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const routes = await sess.call<RouteView[]>("usage");
        if (ctx.json()) return ctx.printJson(routes);
        const s = ctx.s();
        const now = new Date().toISOString();
        for (const r of routes) {
          ctx.print(`${s.bold(r.route)} (${r.vendor}, ${r.auth}${r.model ? `, ${r.model}` : ""})${r.pausedUntil ? s.yellow(`  paused until ${r.pausedUntil}${r.pauseSource === "backoff" ? " (probing)" : ` (${r.pauseSource})`}`) : ""}`);
          if (!r.windows.some((w) => w.kind !== "budget")) ctx.print("  5h unknown   7d unknown   (no usage data from this vendor)");
          for (const w of r.windows) ctx.print(`  ${windowText(w, now, s)}`);
        }
      } finally {
        sess.close();
      }
    });
}
