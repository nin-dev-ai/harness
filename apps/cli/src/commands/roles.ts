import type { Command } from "commander";
import { loadHarnessConfig, setRoleRoute } from "@harness/config";
import { repoRoot } from "@harness/workspace";
import { table } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";
import { notifyReload } from "./routes.js";

export function register(program: Command, ctx: Ctx): void {
  const roles = program.command("roles").description("List roles, ask the planner for a proposal, or change a role's route");
  roles
    .command("list")
    .description("List roles with their routes and permissions")
    .action(async () => {
      const root = await repoRoot(ctx.dir());
      const c = loadHarnessConfig(root).config;
      const rows = Object.entries(c.roles).map(([name, r]) => ({ name, route: r.route, vendor: c.routes[r.route]?.vendor ?? "?", mode: r.mode, concurrency: r.concurrency, paths: r.paths_allow ?? ["(whole repo)"], fallback: r.fallback }));
      if (ctx.json()) return ctx.printJson(rows);
      ctx.print(table(rows.map((r) => [r.name, r.route, r.vendor, r.mode, `x${r.concurrency}`, r.paths.join(", "), r.fallback !== "none" ? `fallback: ${r.fallback}` : ""]), ["ROLE", "ROUTE", "VENDOR", "MODE", "N", "PATHS", ""]));
    });
  roles
    .command("set <role>")
    .description("Bind a role to a route (the tool never changes this on its own)")
    .requiredOption("--route <route>", "route name from harness.yaml")
    .action(async (role: string, o: { route: string }) => {
      const root = await repoRoot(ctx.dir());
      try {
        setRoleRoute(root, role, o.route);
      } catch (e) {
        throw new CliExit(EXIT.failed, (e as Error).message);
      }
      await notifyReload(ctx);
      ctx.print(`${role} → ${o.route}`);
    });
  roles
    .command("suggest")
    .description("Suggest routes per role from the recorded run history (never changes roles)")
    .action(async () => {
      const { openProject } = await import("./_client.js");
      const sess = await openProject(ctx.io, ctx.dir());
      try {
        const r = await sess.call<{ role: string; current: string; suggested: string | null; reason: string }[]>("roles.suggest");
        if (ctx.json()) return ctx.printJson(r);
        for (const x of r) ctx.print(`${x.role.padEnd(12)} ${x.suggested ? `consider ${x.current} → ${x.suggested}` : `keep ${x.current}`}\n${" ".repeat(13)}${x.reason}`);
        ctx.print("\nTo change a role: harness roles set <role> --route <route>");
      } finally {
        sess.close();
      }
    });
  roles
    .command("propose")
    .description("Ask the planner role's agent to suggest roles and routes")
    .option("--file <prd>", "PRD or notes to base the proposal on")
    .option("--apply", "write the proposed roles into harness.yaml")
    .action(async (o: { file?: string; apply?: boolean }) => {
      const { proposeRoles } = await import("./plan.js");
      await proposeRoles(ctx, o.file, o.apply);
    });
}
