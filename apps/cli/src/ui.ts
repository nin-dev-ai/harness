import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, configFromWizard, writeFileAtomic } from "@harness/config";
import { slugify } from "@harness/core";
import { harnessHome } from "@harness/daemon";
import { git, isGitRepo, repoRoot } from "@harness/workspace";
import type { Ctx } from "./ctx.js";
import { openProject, type ProjectSession } from "./commands/_client.js";
import { detectVendors, initProject } from "./commands/init.js";
import { CliExit, EXIT } from "./io.js";
import { VERSION } from "./version.js";

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

/** Top-level folders (and src/* ones) of a repo, to suggest write scopes. */
async function repoFolders(root: string): Promise<string[]> {
  const files = (await git(root, ["ls-files"]).catch(() => "")).split("\n").filter(Boolean);
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length > 1) out.add(parts[0]!);
    if (parts.length > 2 && parts[0] === "src") out.add(`src/${parts[1]}`);
  }
  for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules") out.add(d.name);
  return [...out].sort();
}

/** The guided setup: writes harness.yaml from the wizard, then checks.yaml and .gitignore. Returns false if cancelled. */
export async function setupWizard(ctx: Ctx, root: string): Promise<boolean> {
  const { runWizard } = await import("@harness/tui");
  const d = await detectVendors();
  const tools = (["claude", "codex", "cursor"] as const).map((v) => ({ vendor: v, installed: d[v].installed, signedIn: d[v].signedIn, version: d[v].version, fixHint: d[v].fixHint }));
  const agents = await runWizard({ project: path.basename(root), tools, folders: await repoFolders(root) });
  if (!agents) return false;
  // Every agent uses its CLI's own login; API keys are opt-in by editing harness.yaml.
  writeFileAtomic(path.join(root, CONFIG_FILE), configFromWizard(slugify(path.basename(root)) || "project", agents));
  await initProject(ctx, { baseline: false, quiet: true });
  return true;
}

/**
 * `harness` with no command, like `claude`: runs the setup wizard in a new
 * repo, then opens the management panel. Closing it never stops the agents.
 */
export async function openUi(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY) throw new CliExit(EXIT.usage, "the terminal UI needs a TTY; use `harness status` in scripts");
  const dir = ctx.dir();
  if (!(await isGitRepo(dir))) throw new CliExit(EXIT.failed, `${dir} is not a git repository. Run \`git init\` here (or cd into a repo), then \`harness\`.`);
  let welcome: string | undefined;
  const root = await repoRoot(dir);
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) {
    if (!(await setupWizard(ctx, root))) {
      ctx.io.out("setup cancelled; nothing was written.");
      return;
    }
    welcome = "saved harness.yaml. Describe what you want built and your agents will split it up.";
  }
  const { runTui } = await import("@harness/tui");
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
      exit = await runTui(api, { prefsFile: path.join(harnessHome(ctx.io.env), "ui.json"), version: VERSION, ...(welcome ? { welcome } : {}) });
      welcome = undefined;
    } finally {
      if (exit?.action !== "attach") sess.close();
    }
    if (exit.action === "quit") {
      ctx.io.out("panel closed. Agents keep working; type `harness` to come back.");
      return;
    }
    if (exit.action === "setup") {
      sess.close();
      if (await setupWizard(ctx, root)) {
        await (await import("./commands/routes.js")).notifyReload(ctx);
        welcome = "saved harness.yaml with your new agents.";
      }
      continue;
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
