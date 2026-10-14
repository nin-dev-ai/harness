import type { Command } from "commander";
import { ValidationError } from "@harness/core";
import { loadProject } from "@harness/config";
import { repoRoot } from "@harness/workspace";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

export function register(program: Command, ctx: Ctx): void {
  const config = program.command("config").description("Configuration");
  config
    .command("check")
    .description("Validate harness.yaml and checks.yaml against their schemas")
    .action(async () => {
      const root = await repoRoot(ctx.dir());
      try {
        const p = loadProject(root);
        if (ctx.json()) ctx.printJson({ ok: true, warnings: p.warnings });
        else {
          ctx.print("harness.yaml and .harness/checks.yaml are valid.");
          for (const w of p.warnings) ctx.print(`warning: ${w.file ?? ""}${w.line ? `:${w.line}` : ""} ${w.message}`);
        }
      } catch (e) {
        if (e instanceof ValidationError) {
          if (ctx.json()) ctx.printJson({ ok: false, errors: e.issues });
          else ctx.io.err(e.message);
          throw new CliExit(EXIT.failed);
        }
        throw e;
      }
    });
}
