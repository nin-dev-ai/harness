import type { Command } from "commander";
import type { Task } from "@harness/core";
import { stateColor } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import { taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

interface ReviewView {
  task: Task;
  diff: string | null;
  stat: string | null;
  files: string[];
  checks: { checkId: string; ok: boolean; required: boolean; durationMs: number | null }[];
  gate: string | null;
  findings: { severity: string; file: string | null; line: number | null; message: string }[];
  runs: { id: string; kind: string; state: string; route: string }[];
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("review <id>")
    .description("Show the diff and evidence for a task; --accept merges it, --reject sends it back")
    .option("--accept", "merge into the integration branch (rebase, re-check, fast-forward)")
    .option("--reject", "send back to the agent")
    .option("-m, --message <comment>", "comment for --reject")
    .option("--diff", "print the full diff")
    .action(async (id: string, o: { accept?: boolean; reject?: boolean; message?: string; diff?: boolean }) => {
      const taskId = taskIdArg(id);
      if (o.reject && !o.message) throw new CliExit(EXIT.usage, "--reject needs -m \"comment\"");
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        if (o.accept) {
          const t = await sess.call<Task>("review.accept", { id: taskId });
          ctx.print(`${t.id} ${t.state}`);
          if (t.state !== "MERGED") throw new CliExit(EXIT.failed);
          return;
        }
        if (o.reject) {
          const t = await sess.call<Task>("review.reject", { id: taskId, comment: o.message });
          ctx.print(`${t.id} sent back (${t.state})`);
          return;
        }
        const r = await sess.call<ReviewView>("review.show", { id: taskId });
        if (ctx.json()) return ctx.printJson(r);
        const s = ctx.s();
        ctx.print(`${s.bold(`${r.task.id} ${r.task.title}`)}  ${stateColor(r.task.state, s)}`);
        ctx.print(`\n${s.bold("Checks")} (${r.gate ?? "not run"})`);
        for (const c of r.checks) ctx.print(`  ${c.ok ? s.green("✓") : s.red("✗")} ${c.checkId}${c.required ? "" : " (optional)"}`);
        ctx.print(`\n${s.bold("Findings")}`);
        if (!r.findings.length) ctx.print("  (none)");
        for (const f of r.findings) ctx.print(`  [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.message}`);
        ctx.print(`\n${s.bold("Changes")}\n${r.stat ?? "(worktree removed)"}`);
        if (o.diff && r.diff) ctx.print(`\n${r.diff}`);
        ctx.print(`\n${s.bold("Runs")}`);
        for (const run of r.runs) ctx.print(`  ${run.id} ${run.kind} ${run.route} ${run.state}`);
        if (r.task.state === "PR_READY") ctx.print(`\naccept: harness review ${r.task.id} --accept    reject: harness review ${r.task.id} --reject -m "..."`);
      } finally {
        sess.close();
      }
    });
}
