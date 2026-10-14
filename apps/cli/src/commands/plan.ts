import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Task } from "@harness/core";
import { stringify } from "yaml";
import { table } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

interface Proposal {
  rationale: string;
  roles: { name: string; route: string; mode: "readonly" | "write"; paths_allow?: string[]; instructions: string }[];
  attempts: number;
}

export async function proposeRoles(ctx: Ctx, file?: string, apply?: boolean): Promise<void> {
  const document = file ? fs.readFileSync(path.resolve(ctx.io.cwd, file), "utf8") : "";
  const sess = await openProject(ctx.io, ctx.dir());
  try {
    ctx.io.err("Asking the planner role for a proposal...");
    const p = await sess.call<Proposal>("roles.propose", { document });
    if (ctx.json()) ctx.printJson(p);
    else {
      ctx.print(p.rationale ? `${p.rationale}\n` : "");
      const roles = Object.fromEntries(p.roles.map((r) => [r.name, { route: r.route, mode: r.mode, ...(r.paths_allow ? { paths_allow: r.paths_allow } : {}), ...(r.instructions ? { instructions: r.instructions } : {}) }]));
      ctx.print(stringify({ roles }));
    }
    if (apply) {
      await sess.call("roles.apply", { proposal: p });
      ctx.print("Applied to harness.yaml.");
    } else if (!ctx.json()) ctx.print("Edit harness.yaml with these roles, or rerun with --apply.");
  } finally {
    sess.close();
  }
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("plan <file>")
    .description("Planner splits a PRD or notes into draft tasks with roles and dependencies")
    .action(async (file: string) => {
      const full = path.resolve(ctx.io.cwd, file);
      if (!fs.existsSync(full)) throw new CliExit(EXIT.usage, `no such file: ${file}`);
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        ctx.io.err("Planning with the planner role (read-only)...");
        const r = await sess.call<{ summary: string; tasks: Task[]; attempts: number; needsApproval: string[] }>("plan", { document: fs.readFileSync(full, "utf8"), source: file });
        if (ctx.json()) return ctx.printJson(r);
        if (r.summary) ctx.print(`${r.summary}\n`);
        ctx.print(table(r.tasks.map((t) => [t.id, t.role, t.size, t.title, t.dependsOn.length ? `after ${t.dependsOn.join(",")}` : ""]), ["ID", "ROLE", "SIZE", "TITLE", "DEPS"]));
        ctx.print(`\n${r.tasks.length} draft task(s)${r.attempts > 1 ? " (planner needed one retry)" : ""}. Nothing runs until you approve:`);
        ctx.print(`  harness approve --all   or   harness approve ${r.tasks[0]?.id ?? "T-001"} ...`);
        if (r.needsApproval.length) ctx.print(`  ${r.needsApproval.join(", ")} expect to touch protected paths and need an extra approval before running.`);
      } finally {
        sess.close();
      }
    });
}
