import type { Command } from "commander";
import { harnessHome, homePaths, isAlive, readPid } from "@harness/daemon";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";
import { connect } from "./_client.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("stop")
    .description("Cancel all runs, kill every child process group, stop the daemon")
    .action(async () => {
      const paths = homePaths(harnessHome(ctx.io.env));
      let client;
      try {
        client = await connect(ctx.io, { start: false });
      } catch {
        ctx.print("daemon not running");
        return;
      }
      const pid = readPid(paths.pid);
      await client.call("daemon.stop").catch(() => undefined);
      client.close();
      const deadline = Date.now() + 15_000;
      while (pid && isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (pid && isAlive(pid)) throw new CliExit(EXIT.failed, `daemon (pid ${pid}) did not stop`);
      ctx.print("stopped: all runs cancelled, daemon exited");
    });
}
