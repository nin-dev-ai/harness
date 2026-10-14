import type { Command } from "commander";
import { buildPrBody, execaRunner, ghAvailable, openDraftPr, type Evidence, type Runner } from "@harness/github";
import { CliExit, EXIT } from "../io.js";
import { taskIdArg, type Ctx } from "../ctx.js";
import { openProject } from "./_client.js";

/** Tests swap this for a recorder; it never touches GitHub then. */
export const prDeps: { run: Runner } = { run: execaRunner };

export function register(program: Command, ctx: Ctx): void {
  program
    .command("pr")
    .description("Open a draft PR from the integration branch (or one task branch) with an evidence block. Never merges.")
    .option("--task <id>", "open a PR for one task branch instead")
    .option("--yes", "do not ask before the first push")
    .option("--dry-run", "print the PR body without pushing")
    .action(async (o: { task?: string; yes?: boolean; dryRun?: boolean }) => {
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const ev = await sess.call<{ evidence: Evidence; title: string; existing: string | null; firstPush: boolean; taskIds: string[] }>("pr.evidence", o.task ? { taskId: taskIdArg(o.task) } : {});
        const body = buildPrBody(ev.evidence);
        if (o.dryRun) {
          ctx.print(`# ${ev.title}\n\n${body}`);
          return;
        }
        if (ev.existing) {
          ctx.print(`A PR already exists for ${ev.evidence.head}: ${ev.existing}`);
          return;
        }
        const root = (await sess.call<{ project: { root: string } }>("status")).project.root;
        const ghOk = await ghAvailable(prDeps.run, root);
        if (!ghOk.ok) throw new CliExit(EXIT.failed, ghOk.detail);
        if (ev.firstPush && !o.yes) {
          const a = ((await ctx.io.prompt?.(`Push ${ev.evidence.head} to origin and open a draft PR into ${ev.evidence.base}? [y/N] `)) ?? "").trim().toLowerCase();
          if (!a.startsWith("y")) throw new CliExit(EXIT.failed, "not pushed");
        }
        const r = await openDraftPr({ cwd: root, base: ev.evidence.base, head: ev.evidence.head, title: ev.title, body, run: prDeps.run });
        await sess.call("pr.record", { url: r.url, branch: ev.evidence.head, taskIds: ev.taskIds });
        ctx.print(`${r.existed ? "Existing draft PR" : "Opened draft PR"}: ${r.url}\nMerging is up to you.`);
      } finally {
        sess.close();
      }
    });
}
