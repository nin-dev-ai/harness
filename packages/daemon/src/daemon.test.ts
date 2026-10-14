import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, taskBranch } from "@harness/core";
import { pidAlive } from "@harness/adapters";
import { createWorktree, ensureIntegrationBranch } from "@harness/workspace";
import { createScenario, type Scenario } from "../../../tests/helpers/scenario.js";
import { waitFor } from "../../../tests/helpers/fake-clock.js";
import { Daemon } from "./daemon.js";
import { DaemonClient } from "./client.js";
import { acquireDaemonLock } from "./lock.js";

describe("daemon core", () => {
  let s: Scenario;
  beforeEach(() => {
    s = createScenario();
  });
  afterEach(() => s.cleanup());

  const make = (o: { noServer?: boolean } = {}) => new Daemon({ home: s.home, clock: new FakeClock(), adapterFactory: (r) => s.adapterFactory(r), noServer: o.noServer ?? true });

  it("opens a project, creates workers and tasks through events", async () => {
    const d = make();
    await d.start();
    const p = await d.openProject(s.repo.root);
    expect(p.id).toMatch(/^demo-[0-9a-f]{6}$/);
    expect(d.store.workers.list(p.id).map((w) => w.id)).toEqual(["backend-1", "frontend-1", "reviewer-1"]);
    const t = p.createTask({ title: "Add panel", role: "frontend" });
    expect(t).toMatchObject({ id: "T-001", state: "DRAFT" });
    expect(fs.readFileSync(path.join(s.repo.root, ".harness/tasks/T-001.md"), "utf8")).toContain("title: Add panel");
    p.transition("T-001", "QUEUED");
    expect(fs.readFileSync(path.join(s.repo.root, ".harness/tasks/T-001.md"), "utf8")).toContain("state: QUEUED");
    expect(() => p.transition("T-001", "MERGED")).toThrow(/illegal/);
    expect(() => p.createTask({ title: "x", role: "nope" })).toThrow(/unknown role/);
    await d.stop();
  });

  it("serves RPC and pushes subscribed events over the socket", async () => {
    const d = make({ noServer: false });
    await d.start();
    const p = await d.openProject(s.repo.root);
    const c = await DaemonClient.connect(d.paths.sock);
    expect(await c.call("ping")).toMatchObject({ version: "0.1.0" });
    const seen: string[] = [];
    c.onEvent((e) => seen.push(e.type));
    await c.call("events.subscribe", { projectId: p.id });
    p.createTask({ title: "x", role: "backend" });
    await waitFor(() => seen.includes("task.created"), 2000, "pushed event");
    await expect(c.call("nope")).rejects.toThrow(/unknown method/);
    c.close();
    await d.stop();
    await expect(DaemonClient.connect(d.paths.sock, 300)).rejects.toThrow(/not reachable/);
  });

  it("allows only one daemon per home", async () => {
    const d = make({ noServer: false });
    await d.start();
    expect(() => acquireDaemonLock(d.paths.pid, process.pid + 1)).toThrow(/already running/);
    await d.stop();
    expect(fs.existsSync(d.paths.pid)).toBe(false);
  });

  it("recovers after a crash mid-run: kills the orphan, checkpoints once, requeues", async () => {
    s.scripts.set("T-001", { steps: [{ kind: "file_change", path: "src/ui/panel.ts", content: "export {};\n" }, { kind: "spawn_child" }, { kind: "hang" }] });
    const d1 = make();
    await d1.start();
    const p1 = await d1.openProject(s.repo.root);
    p1.createTask({ title: "Panel", role: "frontend", state: "QUEUED" });
    await ensureIntegrationBranch(s.repo.root, "harness/integration", "main");
    const branch = taskBranch("frontend", "T-001", "Panel");
    const wt = await createWorktree(s.repo.root, "T-001", branch, "harness/integration");
    p1.emit("task.updated", { fields: { branch, worktree: ".harness/worktrees/T-001" } }, { taskId: "T-001" });
    p1.transition("T-001", "RUNNING");
    const { runId, done } = d1.supervisor.start(p1, { taskId: "T-001", workerId: "frontend-1", route: "fast", kind: "initial", prompt: "go", cwd: wt.path, mode: "write", allowedPaths: [], timeoutMs: 60_000 });
    done.catch(() => undefined);
    await waitFor(() => fs.existsSync(path.join(wt.path, "src/ui/panel.ts")), 5000, "agent wrote a file");
    await waitFor(() => (d1.store.runs.get(runId)?.pid ?? 0) > 0, 5000, "run pid recorded");
    const pid = d1.store.runs.get(runId)!.pid!;
    expect(pidAlive(pid)).toBe(true);

    d1.crashForTest(); // like SIGKILL: no cleanup, agent still running

    const d2 = make();
    await d2.start();
    const p2 = d2.project(p1.id);
    expect(pidAlive(pid)).toBe(false);
    expect(d2.store.runs.get(runId)).toMatchObject({ state: "FAILED", errorKind: "crashed" });
    expect(p2.task("T-001").state).toBe("QUEUED");
    const log = s.repo.git("log", "--format=%s", `harness/integration..${branch}`);
    expect(log).toBe(`wip(T-001): checkpoint ${runId}`);
    expect(d2.store.events.list({ projectId: p2.id, types: ["daemon.recovered"] })).toHaveLength(1);
    await d2.stop();

    // A second restart finds nothing to recover and makes no new commit.
    const d3 = make();
    await d3.start();
    expect(s.repo.git("log", "--format=%s", `harness/integration..${branch}`)).toBe(log);
    expect(d3.store.events.list({ types: ["daemon.recovered"] })).toHaveLength(1);
    await d3.stop();
  });
});
