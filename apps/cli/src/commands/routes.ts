import type { Command } from "commander";
import { addRoute, effectiveUnattended, loadHarnessConfig, removeRoute, setUnattended } from "@harness/config";
import { VENDOR_TERMS } from "@harness/policy";
import { DaemonClient, harnessHome, homePaths } from "@harness/daemon";
import { repoRoot } from "@harness/workspace";
import type { Vendor } from "@harness/core";
import { table } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

/** If the daemon is running, tell it the config changed. Never starts it. */
export async function notifyReload(ctx: Ctx): Promise<void> {
  try {
    const c = await DaemonClient.connect(homePaths(harnessHome(ctx.io.env)).sock, 500);
    try {
      const p = await c.call<{ projectId: string }>("project.open", { path: ctx.dir(), attended: true });
      await c.call("project.reload", { projectId: p.projectId, attended: true });
    } finally {
      c.close();
    }
  } catch {
    // daemon not running: it reads the config when it starts
  }
}

export function register(program: Command, ctx: Ctx): void {
  const routes = program.command("routes").description("Manage routes (vendor, auth method, model)");
  routes
    .command("list")
    .description("List routes")
    .action(async () => {
      const root = await repoRoot(ctx.dir());
      const c = loadHarnessConfig(root).config;
      const rows = Object.entries(c.routes).map(([name, r]) => ({ name, ...r, unattended: effectiveUnattended(c, name), roles: Object.entries(c.roles).filter(([, x]) => x.route === name).map(([n]) => n) }));
      if (ctx.json()) return ctx.printJson(rows);
      ctx.print(table(rows.map((r) => [r.name, r.vendor, r.auth, r.model ?? "(CLI default)", `unattended: ${r.unattended}`, r.roles.join(", ")]), ["ROUTE", "VENDOR", "AUTH", "MODEL", "", "ROLES"]));
    });
  routes
    .command("add <name>")
    .description("Add a route")
    .requiredOption("--vendor <vendor>", "claude | codex | cursor")
    .option("--auth <auth>", "subscription | api_key", "subscription")
    .option("--model <model>", "exact model id passed to the CLI")
    .action(async (name: string, o: { vendor: string; auth: string; model?: string }) => {
      const root = await repoRoot(ctx.dir());
      try {
        addRoute(root, name, { vendor: o.vendor, auth: o.auth, ...(o.model ? { model: o.model } : {}) });
      } catch (e) {
        throw new CliExit(EXIT.failed, (e as Error).message);
      }
      await notifyReload(ctx);
      ctx.print(`added route ${name}`);
    });
  routes
    .command("remove <name>")
    .description("Remove a route (fails while a role uses it)")
    .action(async (name: string) => {
      const root = await repoRoot(ctx.dir());
      try {
        removeRoute(root, name);
      } catch (e) {
        throw new CliExit(EXIT.failed, (e as Error).message);
      }
      await notifyReload(ctx);
      ctx.print(`removed route ${name}`);
    });
  routes
    .command("unattended <route> <setting>")
    .description("Set whether the scheduler may dispatch on a route while nobody is attached (allow | ask | deny)")
    .option("--confirm <route>", "confirm a subscription route set to allow by typing its name (non-interactive)")
    .action(async (route: string, setting: string, o: { confirm?: string }) => {
      if (!["allow", "ask", "deny"].includes(setting)) throw new CliExit(EXIT.usage, "setting must be allow, ask or deny");
      const root = await repoRoot(ctx.dir());
      const c = loadHarnessConfig(root).config;
      const r = c.routes[route];
      if (!r) throw new CliExit(EXIT.failed, `unknown route "${route}"`);
      if (setting === "allow" && r.auth === "subscription") {
        ctx.print(`Each vendor sets its own rules for automated and unattended use of subscription plans.\nRead ${r.vendor}'s current terms before allowing this: ${VENDOR_TERMS[r.vendor as Vendor]}`);
        const typed = o.confirm ?? (ctx.io.prompt ? (await ctx.io.prompt(`Type the route name (${route}) to confirm: `)).trim() : "");
        if (typed !== route) throw new CliExit(EXIT.failed, "not confirmed; nothing changed");
      }
      setUnattended(root, route, setting as "allow" | "ask" | "deny");
      await notifyReload(ctx);
      ctx.print(`${route}: unattended ${setting} (recorded ${new Date().toISOString()})`);
    });
}
