import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../apps/cli/src/main.js";
import { StatusJsonSchema } from "../../apps/cli/src/schemas.js";
import type { Io } from "../../apps/cli/src/io.js";
import { pidAlive } from "@harness/adapters";
import { homePaths, readPid } from "@harness/daemon";
import { createTempRepo, type TempRepo } from "../helpers/temp-repo.js";
import { DEFAULT_CHECKS, DEFAULT_CONFIG } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/**
 * Restart safety with real processes: SIGKILL the daemon mid-run, restart it,
 * and check the task still merges exactly once with no orphaned agents.
 */
const ROUNDS = 5;

describe("crash-recovery (real daemon process)", () => {
  let repo: TempRepo;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const sh = async (...argv: string[]) => {
    const out: string[] = [];
    const io: Io = { out: (t) => out.push(t), err: () => undefined, env, cwd: repo.root, color: false };
    const code = await main(argv, io);
    return { code, out: out.join("\n") };
  };
  const status = async () => StatusJsonSchema.parse(JSON.parse((await sh("status", "--json")).out));

  beforeAll(() => {
    repo = createTempRepo({ "README.md": "# r\n" });
    // A manual budget replaces the conservative cap for routes with unknown usage.
    repo.write("harness.yaml", DEFAULT_CONFIG.replace("limits:\n", "limits:\n  routes:\n    slow: { manual_budget: { unit: runs, per: day, amount: 100 } }\n"));
    repo.write(".harness/checks.yaml", DEFAULT_CHECKS);
    repo.commit("cfg");
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-crash-")));
    const scripts: Record<string, unknown> = {};
    for (let i = 1; i <= ROUNDS; i++) {
      const id = `T-00${i}`;
      scripts[id] = {
        sessionId: `sess-${id}`,
        steps: [{ kind: "file_change", path: `src/server/${id}-a.ts`, content: "a\n" }, { kind: "spawn_child" }, { kind: "hang" }],
        resumeSteps: [{ kind: "file_change", path: `src/server/${id}-b.ts`, content: "b\n" }, { kind: "result", ok: true, summary: "resumed" }],
      };
    }
    fs.writeFileSync(path.join(home, "scripts.json"), JSON.stringify(scripts));
    env = { ...process.env, HARNESS_HOME: home, HARNESS_FAKE_SCRIPTS: path.join(home, "scripts.json"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  });
  afterAll(async () => {
    await sh("stop");
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(`survives ${ROUNDS} forced daemon kills with no duplicate commit and no orphans`, async () => {
    expect((await sh("run")).code).toBe(0);
    for (let i = 1; i <= ROUNDS; i++) {
      const id = `T-00${i}`;
      expect((await sh("task", "add", `Round ${i}`, "--role", "backend", "--approve")).code).toBe(0);
      // Wait until the agent is mid-run (it wrote its first file and hangs).
      await waitFor(() => fs.existsSync(path.join(repo.root, `.harness/worktrees/${id}/src/server/${id}-a.ts`)), 20_000, `${id} mid-run`);
      await waitFor(async () => (await status()).workers.some((w) => w.taskId === id), 10_000, `${id} live`);
      const runEvents = JSON.parse((await sh("logs", `R-${id}-1`, "--json")).out) as { type: string; payload: { event?: { type: string; pid?: number; raw?: { pid?: number } } } }[];
      const agentPid = runEvents.find((e) => e.payload.event?.type === "started")?.payload.event?.pid;
      await waitFor(async () => {
        const evs = JSON.parse((await sh("logs", `R-${id}-1`, "--json")).out) as typeof runEvents;
        return evs.some((e) => e.payload.event?.raw?.pid);
      }, 10_000, "grandchild pid");
      const childPid = (JSON.parse((await sh("logs", `R-${id}-1`, "--json")).out) as typeof runEvents).find((e) => e.payload.event?.raw?.pid)!.payload.event!.raw!.pid!;

      const daemonPid = readPid(homePaths(home).pid)!;
      process.kill(daemonPid, "SIGKILL");
      await waitFor(() => !pidAlive(daemonPid), 5000, "daemon dead");
      expect(pidAlive(agentPid!)).toBe(true); // the orphan is still there until recovery

      await waitFor(async () => (await status()).tasks.find((t) => t.id === id)?.state === "MERGED", 30_000, `${id} merged after restart`);
      expect(pidAlive(agentPid!)).toBe(false);
      expect(pidAlive(childPid)).toBe(false);
    }
    const subjects = repo.git("log", "--format=%s", "main..harness/integration").split("\n");
    expect(subjects).toHaveLength(ROUNDS);
    expect(new Set(subjects).size).toBe(ROUNDS);
    for (let i = 1; i <= ROUNDS; i++) {
      const files = repo.git("ls-tree", "-r", "--name-only", "harness/integration");
      expect(files).toContain(`src/server/T-00${i}-a.ts`);
      expect(files).toContain(`src/server/T-00${i}-b.ts`);
    }
    const snap = await status();
    for (const t of snap.tasks) expect(t.attempts).toBe(1);
  }, 240_000);
});
