import type { Command } from "commander";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

export async function proposeRoles(_ctx: Ctx, _file?: string): Promise<void> {
  throw new CliExit(EXIT.failed, "roles propose arrives with the planner (M12)");
}

export function register(program: Command, _ctx: Ctx): void {
  program
    .command("plan <file>")
    .description("Planner splits a PRD or notes into draft tasks with roles and dependencies")
    .action(() => {
      throw new CliExit(EXIT.failed, "plan arrives with the planner (M12)");
    });
}
