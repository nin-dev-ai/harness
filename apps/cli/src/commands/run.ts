import type { Command } from "commander";
import { CliExit, EXIT } from "../io.js";
import { taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

/** "14:30" today (or tomorrow if past), or any ISO time. */
export function parseUntil(s: string, now = new Date()): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m) {
    const t = new Date(now);
    t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new CliExit(EXIT.usage, `bad --until "${s}" (use HH:MM or an ISO time)`);
  return d.toISOString();
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("run")
    .description("Start or resume the scheduler loop (the daemon keeps running it)")
    .option("--role <role>", "only dispatch this role's tasks")
    .option("--task <id>", "only dispatch this task")
    .option("--until <time>", "stop dispatching new work after this time (HH:MM or ISO)")
    .action(async (o: { role?: string; task?: string; until?: string }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        await sess.call("run", { ...(o.role ? { role: o.role } : {}), ...(o.task ? { task: taskIdArg(o.task) } : {}), ...(o.until ? { until: parseUntil(o.until) } : {}) });
        ctx.print(`scheduler running${o.until ? ` until ${o.until}` : ""}. Watch with \`harness\` or \`harness status --watch\`.`);
      } finally {
        sess.close();
      }
    });
}
