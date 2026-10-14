import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "@harness/config";
import { harnessHome } from "@harness/daemon";
import { isGitRepo, repoRoot } from "@harness/workspace";
import type { Ctx } from "./ctx.js";
import { openProject, type ProjectSession } from "./commands/_client.js";
import { initProject } from "./commands/init.js";
import { CliExit, EXIT } from "./io.js";

/** Takeover: pause at a safe point, run the vendor's interactive CLI in the worktree, then ask what next. */
export async function attachFlow(ctx: Ctx, sess: ProjectSession, target: string): Promise<void> {
  const r = await sess.call<{ taskId: string; argv: string[]; cwd: string; sessionId: string | null; route: string }>("attach.prepare", { target });
  ctx.io.out(`${r.taskId} is yours. A wip checkpoint is committed in ${r.cwd}.`);
  if (r.argv.length) {
    ctx.io.out(`Starting: ${r.argv.join(" ")}  (exit it to come back)\n`);
    spawnSync(r.argv[0]!, r.argv.slice(1), { cwd: r.cwd, stdio: "inherit", env: ctx.io.env });
  } else {
    ctx.io.out(`No vendor session to resume. Work in ${r.cwd}, then come back here.`);
    await ctx.io.prompt?.("Press Enter when you are done... ");
  }
  const answer = ((await ctx.io.prompt?.(`Resume automation on ${r.taskId}? [Y/n] `)) ?? "y").trim().toLowerCase();
  const resume = answer === "" || answer.startsWith("y");
  await sess.call("attach.done", { taskId: r.taskId, resume });
  ctx.io.out(resume ? `${r.taskId} handed back to the scheduler.` : `${r.taskId} stays with you (TAKEN_OVER). \`harness task requeue ${r.taskId}\` hands it back.`);
}

/**
 * `harness` with no command, like `claude`: sets up a new repo on first use,
 * then opens the chat UI. Closing it never stops the agents (/stop does).
 */
export async function openUi(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY) throw new CliExit(EXIT.usage, "the terminal UI needs a TTY; use `harness status` in scripts");
  const dir = ctx.dir();
  if (!(await isGitRepo(dir))) throw new CliExit(EXIT.failed, `${dir} is not a git repository. Run \`git init\` here (or cd into a repo), then \`harness\`.`);
  let welcome: string | undefined;
  if (!fs.existsSync(path.join(await repoRoot(dir), CONFIG_FILE))) {
    ctx.io.out("✦ first time here: setting up harness for this repo…");
    const r = await initProject(ctx, { baseline: false, quiet: true });
    welcome = r.vendors.length
      ? `set up harness.yaml with ${r.vendors.join(", ")} (edit it any time) and .harness/checks.yaml from your repo`
      : "set up harness.yaml, but no signed-in claude, codex or cursor-agent was found: run `harness doctor`";
  }
  const { runTui } = await import("@harness/tui");
  const prefsFile = path.join(harnessHome(ctx.io.env), "ui.json");
  for (;;) {
    const sess = await openProject(ctx.io, dir);
    const api = {
      call: <T,>(method: string, params: Record<string, unknown> = {}) => sess.call<T>(method, params),
      onEvent: sess.client.onEvent.bind(sess.client),
      subscribe: async () => {
        await sess.client.call("events.subscribe", { projectId: sess.projectId });
      },
    };
    let exit;
    try {
      exit = await runTui(api, { prefsFile, ...(welcome ? { welcome } : {}) });
      welcome = undefined;
    } finally {
      if (exit?.action !== "attach") sess.close();
    }
    if (exit.action === "quit") {
      ctx.io.out("✦ bye. Agents keep working; type `harness` to come back.");
      return;
    }
    if (exit.action === "stop") {
      await sess.client.call("daemon.stop").catch(() => undefined);
      ctx.io.out("stopping: all runs cancelled, daemon exiting");
      return;
    }
    try {
      await attachFlow(ctx, sess, exit.target);
    } finally {
      sess.close();
    }
  }
}
