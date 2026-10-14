import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../apps/cli/src/main.js";
import { StatusJsonSchema, type StatusJson } from "../../apps/cli/src/schemas.js";
import { parseUntil } from "../../apps/cli/src/commands/run.js";
import type { Io } from "../../apps/cli/src/io.js";
import { createTempRepo, type TempRepo } from "../helpers/temp-repo.js";
import { DEFAULT_CHECKS, DEFAULT_CONFIG } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** The `harness` CLI end to end: real daemon subprocess, fake agents. */
describe("cli", () => {
  let repo: TempRepo;
  let home: string;
  let env: NodeJS.ProcessEnv;

  const sh = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), env, cwd: repo.root, color: false, prompt: async () => "" };
    const code = await main(argv, io);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const status = async (): Promise<StatusJson> => StatusJsonSchema.parse(JSON.parse((await sh("status", "--json")).out));

  beforeAll(() => {
    repo = createTempRepo({ "README.md": "# demo\n", "src/shared/a.ts": "export const a = 1;\n" });
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-cli-home-")));
    const scripts = path.join(home, "scripts.json");
    fs.writeFileSync(
      scripts,
      JSON.stringify({
        "T-001": { steps: [{ kind: "file_change", path: "src/server/api.ts", content: "export const api = 1;\n" }, { kind: "result", ok: true, summary: "api done" }] },
        "T-002": { steps: [{ kind: "file_change", path: "src/ui/panel.ts", content: "export const panel = 1;\n" }, { kind: "result", ok: true, summary: "panel done" }] },
        "*": { steps: [{ kind: "hang" }] },
      }),
    );
    env = { ...process.env, HARNESS_HOME: home, HARNESS_FAKE_SCRIPTS: scripts, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  });
  afterAll(async () => {
    await sh("stop");
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("init writes config, checks and gitignore, and prints readiness", async () => {
    repo.write("package.json", JSON.stringify({ scripts: { test: "node -e 0", lint: "node -e 0" } }));
    repo.commit("pkg");
    const r = await sh("init", "--no-baseline", "--write-agents-md");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Readiness:");
    expect(fs.existsSync(path.join(repo.root, "harness.yaml"))).toBe(true);
    expect(fs.readFileSync(path.join(repo.root, ".harness/checks.yaml"), "utf8")).toContain("unit");
    expect(fs.readFileSync(path.join(repo.root, ".gitignore"), "utf8")).toContain(".harness/worktrees/");
    expect(fs.existsSync(path.join(repo.root, "AGENTS.md"))).toBe(true);
    expect(r.out).not.toMatch(/sk-ant|gho_|token/i);
    // Use the fake vendor for the rest of the suite.
    repo.write("harness.yaml", DEFAULT_CONFIG);
    repo.write(".harness/checks.yaml", DEFAULT_CHECKS);
    repo.commit("harness config");
  }, 60_000);

  it("config check, doctor, roles and routes", async () => {
    expect((await sh("config", "check")).code).toBe(0);
    const doc = await sh("doctor", "--json");
    expect(doc.code).toBe(0);
    expect(JSON.parse(doc.out).ok).toBe(true);
    const roles = JSON.parse((await sh("roles", "list", "--json")).out) as { name: string; route: string }[];
    expect(roles.map((r) => r.name)).toEqual(["frontend", "backend", "reviewer"]);
    expect((await sh("roles", "set", "backend", "--route", "nope")).code).toBe(1);
    const routes = JSON.parse((await sh("routes", "list", "--json")).out) as { name: string; unattended: string }[];
    expect(routes.find((r) => r.name === "slow")?.unattended).toBe("allow");
    repo.write("harness.yaml", DEFAULT_CONFIG.replace("routes:\n  fast:", "routes:\n  sub:\n    vendor: fake\n    auth: subscription\n  fast:"));
    const denied = await sh("routes", "unattended", "sub", "allow");
    expect(denied.code).toBe(1);
    expect(denied.out).toContain("terms");
    expect((await sh("routes", "unattended", "sub", "allow", "--confirm", "sub")).code).toBe(0);
    repo.write("harness.yaml", DEFAULT_CONFIG);
  });

  it("adds, approves and runs tasks to MERGED through the daemon", async () => {
    const a = await sh("task", "add", "API", "--role", "backend", "--acceptance", "exports api");
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^T-001 DRAFT backend: API/);
    expect((await sh("task", "add", "Panel", "--role", "frontend", "--after", "1", "--approve")).out).toMatch(/^T-002 QUEUED/);
    expect((await sh("approve", "T-001")).out).toContain("approved: T-001");
    expect((await sh("run")).code).toBe(0);
    await waitFor(async () => (await status()).tasks.every((t) => t.state === "MERGED"), 40_000, "both merged");
    const snap = await status();
    expect(snap.scheduler.running).toBe(true);
    expect(snap.tasks.map((t) => t.id)).toEqual(["T-001", "T-002"]);
    expect(repo.git("log", "--format=%s", "main..harness/integration").split("\n")).toEqual(["T-002: Panel", "T-001: API"]);
    const text = await sh("status");
    expect(text.out).toContain("harness · demo");
    expect(text.out).toContain("MERGED");
  }, 60_000);

  it("shows tasks, logs, review, usage and exports", async () => {
    const show = await sh("task", "show", "T-001");
    expect(show.out).toContain("T-001 API");
    expect(show.out).toContain("✓ unit");
    const logs = await sh("logs", "R-T-001-1");
    expect(logs.out).toContain("› edit src/server/api.ts");
    expect(logs.out).toContain("✓ result: api done");
    expect((await sh("logs", "R-T-001-1", "--raw")).out).toContain('"type":"exited"');
    const rev = JSON.parse((await sh("review", "T-001", "--json")).out) as { gate: string; findings: unknown[] };
    expect(rev.gate).toBe("gate.passed");
    const usage = JSON.parse((await sh("usage", "--json")).out) as { route: string }[];
    expect(usage.map((u) => u.route)).toEqual(["fast", "slow", "rev"]);
    expect((await sh("usage")).out).toContain("5h unknown");
    expect((await sh("limits", "set", "fast", "--window", "budget", "--budget", "10 runs/day")).code).toBe(0);
    expect(fs.readFileSync(path.join(repo.root, "harness.yaml"), "utf8")).toContain("amount: 10");
    expect((await sh("limits", "set", "fast", "--window", "budget", "--budget", "lots")).code).toBe(2);
    const out = path.join(home, "export.jsonl");
    expect((await sh("export", "--out", out)).code).toBe(0);
    const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
    expect(lines.filter((l) => l.kind === "task")).toHaveLength(2);
    expect(lines.some((l) => l.kind === "event")).toBe(true);
  }, 30_000);

  it("pauses, resumes, cancels and edits", async () => {
    expect((await sh("task", "add", "Hang", "--role", "backend", "--approve")).code).toBe(0);
    await waitFor(async () => (await status()).tasks.find((t) => t.id === "T-003")?.state === "RUNNING", 20_000, "T-003 running");
    expect((await sh("pause", "--task", "T-003")).code).toBe(0);
    await waitFor(async () => (await status()).tasks.find((t) => t.id === "T-003")?.state === "PAUSED", 10_000, "paused");
    expect((await sh("task", "edit", "T-003", "--title", "Hang forever")).code).toBe(0);
    expect((await sh("task", "cancel", "T-003")).code).toBe(0);
    expect((await status()).tasks.find((t) => t.id === "T-003")?.state).toBe("CANCELLED");
    expect((await sh("pause", "--all")).code).toBe(0);
    expect((await status()).scheduler.running).toBe(false);
    expect((await sh("resume", "--all")).code).toBe(0);
    expect((await status()).scheduler.running).toBe(true);
  }, 40_000);

  it("uses exit codes 2 for usage errors and 3 when the daemon is unreachable", async () => {
    expect((await sh("task", "add")).code).toBe(2);
    expect((await sh("frobnicate")).code).toBe(2);
    expect((await sh("review", "T-001", "--reject")).code).toBe(2);
    expect((await sh("stop")).out).toContain("stopped");
    const saved = env;
    env = { ...env, HARNESS_DAEMON_CMD: JSON.stringify(["/usr/bin/false"]), HARNESS_DAEMON_START_TIMEOUT_MS: "500" };
    expect((await sh("status")).code).toBe(3);
    env = saved;
  }, 30_000);

  it("parses --until", () => {
    const now = new Date(2026, 0, 5, 12, 0);
    expect(new Date(parseUntil("14:30", now)).getHours()).toBe(14);
    expect(new Date(parseUntil("09:00", now)).getDate()).toBe(6);
  });
});
