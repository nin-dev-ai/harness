import { spawnSync } from "node:child_process";
import type { Ctx } from "./ctx.js";
import { openProject, type ProjectSession } from "./commands/_client.js";
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

/** `harness` with no command: the full-screen UI. Closing it never stops the daemon (Q does). */
export async function openUi(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new CliExit(EXIT.usage, "the terminal UI needs a TTY; use `harness status` in scripts");
  }
  const { runTui } = await import("@harness/tui");
  for (;;) {
    const sess = await openProject(ctx.io, ctx.dir());
    const api = {
      call: <T,>(method: string, params: Record<string, unknown> = {}) => sess.call<T>(method, params),
      onEvent: sess.client.onEvent.bind(sess.client),
      subscribe: async () => {
        await sess.client.call("events.subscribe", { projectId: sess.projectId });
      },
    };
    let exit;
    try {
      exit = await runTui(api);
    } finally {
      if (exit?.action !== "attach") sess.close();
    }
    if (exit.action === "quit") return;
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
