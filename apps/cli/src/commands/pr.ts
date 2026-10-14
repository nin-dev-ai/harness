import type { Command } from "commander";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

export function register(program: Command, _ctx: Ctx): void {
  program
    .command("pr")
    .description("Open a draft PR from the integration branch or one task branch")
    .option("--task <id>")
    .action(() => {
      throw new CliExit(EXIT.failed, "pr arrives with the GitHub package (M14)");
    });
}
