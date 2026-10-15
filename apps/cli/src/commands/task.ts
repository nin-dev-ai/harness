import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Task } from "@harness/core";
import { duration, stateColor, table } from "../format.js";
import { collect, taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  const task = program.command("task").description("Create, inspect or change tasks");
  registerImport(task, ctx);
  task
    .command("add <title>")
    .description("Create a task by hand (DRAFT until approved, unless --approve)")
    .option("--role <role>", "role that does the task (default: harness picks)")
    .option("--after <ids>", "tasks that must be merged first (comma-separated, repeatable)", collect, [])
    .option("--spec <file>", "markdown file with the description")
    .option("--size <size>", "S | M | L", "M")
    .option("--acceptance <text>", "acceptance criterion (repeatable)", (v: string, p: string[] = []) => [...p, v], [])
    .option("--files <globs>", "files the task is expected to touch (comma-separated)", collect, [])
    .option("--approve", "approve immediately (QUEUED)")
    .action(async (title: string, o: { role?: string; after: string[]; spec?: string; size: string; acceptance: string[]; files: string[]; approve?: boolean }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const body = o.spec ? fs.readFileSync(path.resolve(ctx.io.cwd, o.spec), "utf8") : "";
        const t = await sess.call<Task>("task.add", {
          title, ...(o.role ? { role: o.role } : {}), size: o.size.toUpperCase(), dependsOn: o.after.map(taskIdArg), body, acceptance: o.acceptance, filesHint: o.files, approve: Boolean(o.approve),
        });
        if (ctx.json()) ctx.printJson(t);
        else ctx.print(`${t.id} ${t.state} ${t.role}: ${t.title}${t.state === "DRAFT" ? `\n  approve with: harness approve ${t.id}` : ""}`);
      } finally {
        sess.close();
      }
    });
  task
    .command("list")
    .description("List tasks")
    .option("--state <states>", "filter by state (comma-separated)", collect, [])
    .action(async (o: { state: string[] }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        let tasks = await sess.call<Task[]>("task.list");
        if (o.state.length) tasks = tasks.filter((t) => o.state.map((x) => x.toUpperCase()).includes(t.state));
        if (ctx.json()) return ctx.printJson(tasks);
        const s = ctx.s();
        ctx.print(tasks.length ? table(tasks.map((t) => [t.id, stateColor(t.state, s), t.role, t.size, t.title, t.dependsOn.length ? `after ${t.dependsOn.join(",")}` : "", t.blockedReason && t.state === "QUEUED" ? `(${t.blockedReason})` : ""]), ["ID", "STATE", "ROLE", "SIZE", "TITLE", "DEPS", ""]) : "(no tasks)");
      } finally {
        sess.close();
      }
    });
  task
    .command("show <id>")
    .description("Show a task with its runs, checks, findings and history")
    .action(async (id: string) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ task: Task; spec: { body: string; front: { acceptance: string[] } } | null; runs: { id: string; kind: string; state: string; route: string; startedAt: string; endedAt: string | null; checks: { checkId: string; ok: boolean }[]; findings: { severity: string; message: string }[] }[]; events: { ts: string; type: string; payload: unknown }[] }>("task.show", { id: taskIdArg(id) });
        if (ctx.json()) return ctx.printJson(r);
        const s = ctx.s();
        const t = r.task;
        ctx.print(`${s.bold(`${t.id} ${t.title}`)}\n  state: ${stateColor(t.state, s)}  role: ${t.role}  size: ${t.size}  attempts: ${t.attempts}/${t.attemptsMax}`);
        if (t.branch) ctx.print(`  branch: ${t.branch}${t.worktree ? `  worktree: ${t.worktree}` : ""}`);
        if (t.dependsOn.length) ctx.print(`  depends on: ${t.dependsOn.join(", ")}`);
        if (r.spec?.front.acceptance.length) ctx.print(`  acceptance:\n${r.spec.front.acceptance.map((a) => `    - ${a}`).join("\n")}`);
        if (r.spec?.body) ctx.print(`\n${r.spec.body}`);
        if (r.runs.length) {
          ctx.print(`\n${s.bold("Runs")}`);
          for (const run of r.runs) {
            const dur = run.endedAt ? duration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : "running";
            ctx.print(`  ${run.id} ${run.kind} ${run.route} ${stateColor(run.state, s)} ${dur}`);
            for (const c of run.checks) ctx.print(`    ${c.ok ? "✓" : "✗"} ${c.checkId}`);
            for (const f of run.findings) ctx.print(`    [${f.severity}] ${f.message}`);
          }
        }
        ctx.print(`\n${s.bold("History")}`);
        for (const e of r.events.slice(-25)) ctx.print(`  ${e.ts.slice(11, 19)} ${e.type} ${s.dim(JSON.stringify(e.payload).slice(0, 100))}`);
      } finally {
        sess.close();
      }
    });
  task
    .command("edit <id>")
    .description("Change a task's title, role, size or dependencies")
    .option("--title <title>")
    .option("--role <role>")
    .option("--size <size>")
    .option("--after <ids>", "replace dependencies (comma-separated)", collect)
    .action(async (id: string, o: { title?: string; role?: string; size?: string; after?: string[] }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const t = await sess.call<Task>("task.edit", { id: taskIdArg(id), ...(o.title ? { title: o.title } : {}), ...(o.role ? { role: o.role } : {}), ...(o.size ? { size: o.size.toUpperCase() } : {}), ...(o.after ? { dependsOn: o.after.map(taskIdArg) } : {}) });
        if (ctx.json()) ctx.printJson(t);
        else ctx.print(`${t.id} updated`);
      } finally {
        sess.close();
      }
    });
  task
    .command("cancel <id>")
    .description("Cancel a task (stops its run)")
    .action(async (id: string) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        await sess.call("task.cancel", { id: taskIdArg(id) });
        ctx.print(`${taskIdArg(id)} cancelled`);
      } finally {
        sess.close();
      }
    });
  task
    .command("requeue <id>")
    .description("Put a NEEDS_HUMAN, STALE or TAKEN_OVER task back in the queue")
    .action(async (id: string) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const t = await sess.call<Task>("task.requeue", { id: taskIdArg(id) });
        ctx.print(`${t.id} ${t.state}`);
      } finally {
        sess.close();
      }
    });
}

/** GitHub issue intake: each labeled issue becomes exactly one DRAFT task, even across restarts. */
export function registerImport(task: Command, ctx: Ctx): void {
  task
    .command("import-issues")
    .description("Create one DRAFT task per open GitHub issue with a label")
    .option("--label <label>", "issue label", "harness")
    .requiredOption("--role <role>", "role for the new tasks")
    .action(async (o: { label: string; role: string }) => {
      const { labeledIssues, issueMarker, issueTaskBody } = await import("@harness/github");
      const { listTaskFiles } = await import("@harness/config");
      const { prDeps } = await import("./pr.js");
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const root = (await sess.call<{ project: { root: string } }>("status")).project.root;
        const issues = await labeledIssues(prDeps.run, root, o.label);
        const bodies = listTaskFiles(root).map((t) => t.body);
        let created = 0;
        for (const i of issues) {
          if (bodies.some((b) => b.includes(issueMarker(i)))) continue;
          const t = await sess.call<Task>("task.add", { title: `#${i.number} ${i.title}`, role: o.role, body: issueTaskBody(i) });
          ctx.print(`${t.id} DRAFT from ${i.url}`);
          created++;
        }
        ctx.print(`${created} new draft task(s) from ${issues.length} issue(s) labeled "${o.label}"`);
      } finally {
        sess.close();
      }
    });
}

