import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { CONFIG_FILE, loadProject, effectiveUnattended } from "@harness/config";
import { VENDOR_TERMS } from "@harness/policy";
import { DaemonClient, harnessHome, homePaths } from "@harness/daemon";
import { isGitRepo, repoRoot } from "@harness/workspace";
import { checkDrift, detectClaude, detectCodex, detectCursor, type DetectResult, type DriftReport, type DriftVendor } from "@harness/adapters";
import { VENDOR_BINARIES } from "@harness/config";
import { execa } from "execa";
import type { Vendor } from "@harness/core";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

interface Finding {
  check: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("doctor")
    .description("Check CLIs, sign-in state, git, config and daemon health (exit 1 if anything blocks a run)")
    .action(async () => {
      const f: Finding[] = [];
      const dir = ctx.dir();
      const git = await isGitRepo(dir);
      f.push({ check: "git", ok: git, blocking: true, detail: git ? "repository found" : "not a git repository", ...(git ? {} : { fix: "git init" }) });
      let routes: { name: string; vendor: Vendor; auth: string; unattended: string }[] = [];
      if (git) {
        const root = await repoRoot(dir);
        if (!fs.existsSync(path.join(root, CONFIG_FILE))) f.push({ check: "config", ok: false, blocking: true, detail: `${CONFIG_FILE} missing`, fix: "harness init" });
        else {
          try {
            const p = loadProject(root);
            f.push({ check: "config", ok: true, blocking: true, detail: `valid${p.warnings.length ? ` (${p.warnings.length} warning(s))` : ""}` });
            for (const w of p.warnings) f.push({ check: "config", ok: true, blocking: false, detail: `warning: ${w.file ?? ""}${w.line ? `:${w.line}` : ""} ${w.message}` });
            routes = Object.entries(p.harness.routes).map(([name, r]) => ({ name, vendor: r.vendor, auth: r.auth, unattended: effectiveUnattended(p.harness, name) }));
          } catch (e) {
            f.push({ check: "config", ok: false, blocking: true, detail: (e as Error).message });
          }
        }
      }
      const detectors: Record<string, (auth: "subscription" | "api_key") => Promise<DetectResult>> = {
        claude: (a) => detectClaude(a), codex: (a) => detectCodex(a), cursor: (a) => detectCursor(a),
      };
      const wanted = routes.length ? routes.filter((r) => r.vendor !== "fake") : (["claude", "codex", "cursor"] as const).map((v) => ({ name: v, vendor: v, auth: "subscription", unattended: "" }));
      const driftChecked = new Set<string>();
      for (const r of wanted) {
        const d = await detectors[r.vendor]!(r.auth as "subscription" | "api_key");
        const ok = d.installed && d.signedIn !== "no";
        f.push({
          check: `route ${r.name}`,
          ok,
          blocking: routes.length > 0,
          detail: `${r.vendor} ${d.installed ? (d.version ?? "installed") : "not installed"}, signed in: ${d.signedIn}, auth: ${r.auth}${r.unattended ? `, unattended: ${r.unattended}` : ""}`,
          ...(d.fixHint ? { fix: d.fixHint } : {}),
        });
        if (d.installed && !driftChecked.has(r.vendor)) {
          driftChecked.add(r.vendor);
          const drift = await vendorDrift(r.vendor as DriftVendor, d.version);
          if (drift) {
            if (drift.missing.length) f.push({ check: `cli ${r.vendor}`, ok: false, blocking: true, detail: `${r.vendor} ${drift.version ?? ""} no longer has flags harness uses: ${drift.missing.join(", ")}`, fix: "update harness, or pin the CLI to the recorded version " + drift.recorded });
            else if (drift.newer) f.push({ check: `cli ${r.vendor}`, ok: true, blocking: false, detail: `${r.vendor} ${drift.version} is newer than the recorded ${drift.recorded}; every flag harness uses is still there` });
          }
        }
        if (r.unattended === "allow" && r.auth === "subscription") f.push({ check: `route ${r.name}`, ok: true, blocking: false, detail: `unattended allowed on a subscription; vendor terms: ${VENDOR_TERMS[r.vendor]}` });
      }
      const paths = homePaths(harnessHome(ctx.io.env));
      try {
        const c = await DaemonClient.connect(paths.sock, 800);
        const pong = await c.call<{ pid: number; version: string }>("ping");
        c.close();
        f.push({ check: "daemon", ok: true, blocking: false, detail: `running (pid ${pong.pid}, v${pong.version})` });
      } catch {
        f.push({ check: "daemon", ok: true, blocking: false, detail: "not running (starts on demand)" });
      }
      const blocked = f.some((x) => !x.ok && x.blocking);
      if (ctx.json()) ctx.printJson({ ok: !blocked, findings: f });
      else {
        const s = ctx.s();
        for (const x of f) ctx.print(`${x.ok ? s.green("✓") : x.blocking ? s.red("✗") : s.yellow("!")} ${x.check.padEnd(14)} ${x.detail}${x.fix ? `\n${" ".repeat(17)}fix: ${x.fix}` : ""}`);
      }
      if (blocked) throw new CliExit(EXIT.failed);
    });
}

/** Drift for one vendor, using the first of its binaries that answers --help. */
async function vendorDrift(vendor: DriftVendor, version: string | undefined): Promise<DriftReport | undefined> {
  for (const bin of VENDOR_BINARIES[vendor]) {
    const ok = await execa(bin, ["--version"], { reject: false, timeout: 10_000, stdin: "ignore" }).then((r) => r.exitCode === 0).catch(() => false);
    if (ok) {
      const r = await checkDrift(vendor, bin, version);
      return r.unreadable && !r.missing.length ? undefined : r;
    }
  }
  return undefined;
}

