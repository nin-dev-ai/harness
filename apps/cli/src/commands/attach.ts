import type { Command } from "commander";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

export function register(program: Command, _ctx: Ctx): void {
  program
    .command("attach <target>")
    .description("Take over a worker interactively (worker id or task id)")
    .action(() => {
      throw new CliExit(EXIT.failed, "attach arrives with the terminal UI (M13)");
    });
}
