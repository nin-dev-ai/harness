import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { slugify, type Vendor } from "@harness/core";
import { CHECKS_FILE, CONFIG_FILE, countTestFiles, detectChecks, loadChecksConfig, starterConfig, TASKS_DIR, writeChecksConfig, writeFileAtomic } from "@harness/config";
import { detectClaude, detectCodex, detectCursor, type DetectResult } from "@harness/adapters";
import { assessReadiness, checkBaseline, formatReadiness, runSetup, type CheckResult } from "@harness/verify";
import { git, gitRaw, isGitRepo, repoRoot } from "@harness/workspace";
import { harnessHome } from "@harness/daemon";
import { table } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import type { Ctx } from "../ctx.js";

export async function detectVendors(): Promise<Record<Exclude<Vendor, "fake">, DetectResult>> {
  const [claude, codex, cursor] = await Promise.all([detectClaude(), detectCodex(), detectCursor("subscription")]);
  return { claude, codex, cursor };
}

export function vendorTable(d: Record<string, DetectResult>): string {
  return table(
    Object.entries(d).map(([v, r]) => [v, r.installed ? "installed" : "missing", r.version ?? "", r.installed ? `signed in: ${r.signedIn}` : "", r.fixHint ? `→ ${r.fixHint}` : ""]),
  );
}

/** Run required checks on a temporary checkout of the base branch. */
export async function baselineChecks(root: string, base: string): Promise<CheckResult[]> {
  const checks = loadChecksConfig(root).config;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-baseline-"));
  try {
    await git(root, ["worktree", "add", "--detach", "-q", dir, base]);
    const setup = await runSetup(dir, checks);
    if (!setup.ok) {
      return [{ checkId: "setup", required: true, ok: false, exitCode: 1, durationMs: 0, timedOut: false, startError: null, outputTail: setup.failed?.output ?? "", signature: null }];
    }
    return await checkBaseline(dir, checks);
  } finally {
    await gitRaw(root, ["worktree", "remove", "--force", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const AGENTS_TEMPLATE = (name: string, checks: string[]) => `# AGENTS.md — ${name}

Conventions every coding agent working in this repository follows.

## Before you finish
Run these checks; the harness runs them again independently:
${checks.map((c) => `- \`${c}\``).join("\n") || "- (no checks configured yet)"}

## Rules
- Keep changes small and focused on the task.
- Follow the style of the surrounding code.
- Do not edit CI configuration, environment files or harness configuration.
- Add or update tests for behavior you change.
`;

export function register(program: Command, ctx: Ctx): void {
  program
    .command("init")
    .description("Set up the project: detect CLIs, scan the repo, write config, print the readiness report")
    .option("--no-baseline", "skip running the required checks on the base branch")
    .option("--write-agents-md", "create a minimal AGENTS.md if it is missing")
    .action(async (o: { baseline: boolean; writeAgentsMd?: boolean }) => {
      const { io } = ctx;
      const s = ctx.s();
      if (!(await isGitRepo(ctx.dir()))) throw new CliExit(EXIT.failed, `${ctx.dir()} is not a git repository. Run \`git init\` first.`);
      const root = await repoRoot(ctx.dir());
      fs.mkdirSync(harnessHome(io.env), { recursive: true });

      io.out(s.bold("Vendor CLIs"));
      const vendors = await detectVendors();
      io.out(vendorTable(vendors));
      const usable = (Object.entries(vendors) as [Vendor, DetectResult][]).filter(([, r]) => r.installed && r.signedIn !== "no").map(([v]) => v);

      const cfgPath = path.join(root, CONFIG_FILE);
      if (!fs.existsSync(cfgPath)) {
        writeFileAtomic(cfgPath, starterConfig(slugify(path.basename(root)) || "project", usable));
        io.out(`\nWrote ${CONFIG_FILE} with routes for: ${usable.join(", ") || "(none found: edit routes before running)"}`);
      } else io.out(`\n${CONFIG_FILE} exists; left unchanged.`);

      const checksPath = path.join(root, CHECKS_FILE);
      if (!fs.existsSync(checksPath)) {
        const d = detectChecks(root);
        writeChecksConfig(root, d.checks);
        io.out(`Wrote ${CHECKS_FILE}:`);
        for (const line of d.sources) io.out(`  ${line}`);
        if (!d.sources.length) io.out("  (no checks detected: add them before running)");
      } else io.out(`${CHECKS_FILE} exists; left unchanged.`);

      fs.mkdirSync(path.join(root, TASKS_DIR), { recursive: true });
      const gi = path.join(root, ".gitignore");
      const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
      const need = [".harness/worktrees/", ".harness/runs/"].filter((l) => !current.split("\n").includes(l));
      if (need.length) fs.writeFileSync(gi, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${need.join("\n")}\n`);

      const checks = loadChecksConfig(root).config;
      if (!fs.existsSync(path.join(root, "AGENTS.md")) && o.writeAgentsMd) {
        fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_TEMPLATE(path.basename(root), checks.checks.map((c) => c.argv.join(" "))));
        io.out("Wrote AGENTS.md (edit it to match your conventions).");
      }

      let baseline: CheckResult[] | undefined;
      if (o.baseline && checks.checks.some((c) => c.required)) {
        io.out("\nRunning required checks on the base branch (baseline)...");
        const base = (await import("@harness/config")).loadHarnessConfig(root).config.base_branch;
        baseline = await baselineChecks(root, base);
      }
      const report = assessReadiness({ root, checks, testsFound: countTestFiles(root), ...(baseline ? { baseline } : {}) });
      io.out(`\n${formatReadiness(report)}`);
      if (!report.agentsMd && !o.writeAgentsMd) io.out("  (run `harness init --write-agents-md` to create a starter AGENTS.md)");
      io.out(`\nNext: edit ${CONFIG_FILE} roles, then \`harness task add\` or \`harness plan <prd>\`, then \`harness run\`.`);
      if (report.grade === "blocked") throw new CliExit(EXIT.failed, "readiness: blocked (fix the baseline before running agents)");
    });
}
