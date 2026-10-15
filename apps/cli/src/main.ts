#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { ValidationError, type HarnessError } from "@harness/core";
import { makeCtx } from "./ctx.js";
import { CliExit, EXIT, processIo, type Io } from "./io.js";
import * as approve from "./commands/approve.js";
import * as board from "./commands/board.js";
import * as attach from "./commands/attach.js";
import * as config from "./commands/config.js";
import * as doctor from "./commands/doctor.js";
import * as exportCmd from "./commands/export.js";
import * as init from "./commands/init.js";
import * as limits from "./commands/limits.js";
import * as logs from "./commands/logs.js";
import * as pause from "./commands/pause.js";
import * as plan from "./commands/plan.js";
import * as pr from "./commands/pr.js";
import * as review from "./commands/review.js";
import * as roles from "./commands/roles.js";
import * as routes from "./commands/routes.js";
import * as run from "./commands/run.js";
import * as status from "./commands/status.js";
import * as stop from "./commands/stop.js";
import * as task from "./commands/task.js";
import * as usage from "./commands/usage.js";

import { VERSION } from "./version.js";
export { VERSION };

/** Build the command tree. `harness` with no command opens the terminal UI. */
export function buildProgram(io: Io): Command {
  const program = new Command("harness")
    .description("Run Claude Code, Codex and Cursor's agent as a coordinated team from one terminal.")
    .version(VERSION)
    .option("--project <path>", "project directory (default: current directory)")
    .option("--json", "machine-readable output")
    .option("--no-color", "disable colors")
    .option("--debug", "print stack traces")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, "")), writeErr: (s) => io.err(s.replace(/\n$/, "")) })
    .showHelpAfterError();
  const ctx = makeCtx(io, program);
  for (const m of [init, doctor, roles, routes, plan, task, approve, board, run, pause, stop, status, attach, logs, review, usage, limits, pr, exportCmd, config]) m.register(program, ctx);
  program
    .command("setup")
    .description("Run the setup wizard: pick agents, tools, models and write scopes (rewrites harness.yaml)")
    .action(async () => {
      const { setupWizard } = await import("./ui.js");
      const { repoRoot } = await import("@harness/workspace");
      if (!process.stdout.isTTY) throw new CliExit(EXIT.usage, "setup needs a terminal");
      const root = await repoRoot(ctx.dir());
      const ok = await setupWizard(ctx, root);
      if (ok) await (await import("./commands/routes.js")).notifyReload(ctx);
      io.out(ok ? "saved harness.yaml. Type `harness` to open the panel." : "setup cancelled; nothing was written.");
    });
  program.action(async () => {
    const { openUi } = await import("./ui.js");
    await openUi(ctx);
  });
  program.command("__daemon", { hidden: true }).action(async () => {
    const { runDaemon } = await import("./daemon-entry.js");
    await runDaemon(io.env);
  });
  return program;
}

/** Run the CLI. Returns the exit code: 0 ok, 1 failed or blocked, 2 usage error, 3 daemon unreachable. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CliExit) {
      if (e.message) io.err(e.message);
      return e.code;
    }
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return EXIT.ok;
      return EXIT.usage;
    }
    const err = e as HarnessError & { code?: string };
    if (err.code === "DAEMON_UNREACHABLE") {
      io.err(err.message);
      return EXIT.unreachable;
    }
    if (e instanceof ValidationError || err.code === "VALIDATION") {
      io.err(err.message);
      return EXIT.usage;
    }
    io.err(`error: ${err.message}`);
    if (program.opts().debug && err.stack) io.err(err.stack);
    return EXIT.failed;
  }
}

const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  void main(process.argv.slice(2)).then((code) => {
    if (process.argv[2] !== "__daemon" && !(process.argv[2] === "status" && process.argv.includes("--watch"))) process.exit(code);
    else process.exitCode = code;
  });
}
