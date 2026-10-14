import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pidAlive } from "@harness/adapters";
import { PolicyGuard, QuotaGuard } from "@harness/daemon";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** Policy scenarios (M10): enforcement outside any prompt. */
describe("policy", () => {
  let s: Scenario;
  let h: Harness;
  const presence = { attended: true };
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
    presence.attended = true;
  });

  const start = async (config = DEFAULT_CONFIG) => {
    s = createScenario({ config });
    h = await startHarness(s, { guards: (p, _d, kick) => [new PolicyGuard(p, () => presence.attended), new QuotaGuard(p, { kick, rng: () => 0 })] });
    h.engine["opts"].attended = () => presence.attended;
    return h;
  };
  const ev = (type: string, taskId?: string) => h.project.store.events.list({ projectId: h.project.id, types: [type as never], ...(taskId ? { taskId } : {}) });

  it("scope-violation: a change outside paths_allow fails the gate and is reverted", async () => {
    await start();
    s.scripts.set("T-001", byMode({
      sessionId: "s",
      steps: [...writes({ "src/ui/ok.ts": "ok\n", "src/server/sneaky.ts": "x\n" }).steps],
      resumeSteps: [{ kind: "message", text: "understood, staying in scope" }, { kind: "result", ok: true }],
    }));
    const t = h.project.createTask({ title: "UI", role: "frontend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const denied = ev("policy.denied", t.id)[0];
    expect(denied?.type === "policy.denied" && denied.payload).toMatchObject({ rule: "write_scope", files: ["src/server/sneaky.ts"] });
    const files = s.repo.git("ls-tree", "-r", "--name-only", "harness/integration");
    expect(files).toContain("src/ui/ok.ts");
    expect(files).not.toContain("src/server/sneaky.ts");
    const failed = ev("gate.failed", t.id)[0];
    expect(failed?.type === "gate.failed" && failed.payload.failed).toEqual(["scope"]);
    expect(s.adapters.get("fast")!.requests[1]!.prompt).toContain("src/server/sneaky.ts (outside paths_allow)");
  });

  it("unattended-ask: a subscription route stops before an unattended dispatch and waits for confirmation", async () => {
    await start(DEFAULT_CONFIG.replace("  slow:\n    vendor: fake\n    auth: api_key", "  slow:\n    vendor: fake\n    auth: subscription"));
    presence.attended = false;
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => ev("approval.requested", t.id).length > 0, 5000, "approval request");
    await h.engine.idle();
    expect(h.project.task(t.id)).toMatchObject({ state: "QUEUED", blockedReason: "approval" });
    expect(h.project.store.runs.listByTask(h.project.id, t.id)).toHaveLength(0);
    const a = h.project.store.windows.approvals(h.project.id, "PENDING")[0]!;
    expect(a).toMatchObject({ category: "unattended", taskId: t.id });
    h.plugin.decide(h.project, a.id, true);
    h.engine.kick();
    await h.until(t.id, "MERGED");
  });

  it("unattended deny: never dispatches while nobody is attached", async () => {
    await start(DEFAULT_CONFIG + "policy:\n  unattended:\n    slow: deny\n");
    presence.attended = false;
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => ev("policy.denied", t.id).length > 0, 5000);
    expect(h.project.task(t.id).blockedReason).toBe("policy");
    presence.attended = true;
    h.engine.kick();
    await h.until(t.id, "MERGED");
  });

  it("protected paths need approval before merge when attended, and are reverted when unattended", async () => {
    await start(DEFAULT_CONFIG.replace('paths_allow: ["src/server/**", "src/shared/**", "docs/contracts/**"]', 'paths_allow: ["src/server/**", ".github/**"]'));
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n", ".github/workflows/ci.yml": "on: push\n" })));
    const t = h.project.createTask({ title: "CI", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "PR_READY");
    await h.engine.idle();
    expect(h.project.task(t.id).state).toBe("PR_READY");
    const a = h.project.store.windows.approvals(h.project.id, "PENDING").find((x) => x.category === "protected_paths")!;
    expect(a.context).toContain(".github/workflows/ci.yml");
    await h.daemon.handlers()["review.accept"]!({ projectId: h.project.id, id: t.id }, { attended: true, subscribe: () => () => undefined });
    expect(h.project.task(t.id).state).toBe("MERGED");

    presence.attended = false;
    s.scripts.set("T-002", byMode({ sessionId: "x", steps: writes({ "src/server/b.ts": "b\n", ".github/workflows/deploy.yml": "x\n" }).steps, resumeSteps: [{ kind: "result", ok: true }] }));
    const t2 = h.project.createTask({ title: "Deploy", role: "backend", state: "QUEUED" });
    for (const ap of h.project.store.windows.approvals(h.project.id, "PENDING")) h.plugin.decide(h.project, ap.id, true);
    h.engine.kick();
    await waitFor(async () => {
      for (const ap of h.project.store.windows.approvals(h.project.id, "PENDING")) h.plugin.decide(h.project, ap.id, true);
      h.engine.kick();
      return h.project.task(t2.id).state === "MERGED";
    }, 15_000, "T-002 merged");
    expect(ev("policy.denied", t2.id).some((e) => e.type === "policy.denied" && e.payload.rule === "protected_paths")).toBe(true);
    expect(s.repo.git("ls-tree", "-r", "--name-only", "harness/integration")).not.toContain(".github/workflows/deploy.yml");
  });

  it("a new dependency fails the gate unless the task allows it", async () => {
    s = createScenario({ files: { "package.json": JSON.stringify({ name: "x", dependencies: { a: "1" } }, null, 2) } });
    s.repo.write("harness.yaml", DEFAULT_CONFIG.replace('paths_allow: ["src/server/**", "src/shared/**", "docs/contracts/**"]', 'paths_allow: ["src/server/**", "package.json"]'));
    s.repo.commit("cfg");
    h = await startHarness(s, { guards: (p, _d, kick) => [new PolicyGuard(p, () => true), new QuotaGuard(p, { kick })] });
    s.scripts.set("T-001", byMode({
      sessionId: "s",
      steps: writes({ "package.json": JSON.stringify({ name: "x", dependencies: { a: "1", "left-pad": "1" } }, null, 2) }).steps,
      resumeSteps: writes({ "package.json": JSON.stringify({ name: "x", dependencies: { a: "1" } }, null, 2), "src/server/pad.ts": "export const pad = 1;\n" }).steps,
    }));
    const t = h.project.createTask({ title: "Pad", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const f = ev("gate.failed", t.id)[0];
    expect(f?.type === "gate.failed" && f.payload.failed).toEqual(["dependencies"]);
    expect(s.adapters.get("slow")!.requests[1]!.prompt).toContain("left-pad (package.json)");
  });

  it("observe runs nothing; assisted needs a per-task approval", async () => {
    await start(DEFAULT_CONFIG + "policy:\n  autonomy: observe\n");
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => h.project.task(t.id).blockedReason === "policy", 5000);
    expect(h.project.store.runs.listByTask(h.project.id, t.id)).toHaveLength(0);
    await h.stop();
    s.cleanup();

    await start(DEFAULT_CONFIG + "policy:\n  autonomy: assisted\n");
    const t2 = h.project.createTask({ title: "B", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => h.project.task(t2.id).blockedReason === "approval", 5000);
    h.plugin.approve(h.project, [t2.id]);
    h.engine.kick();
    await h.until(t2.id, "PR_READY");
  });

  it("fallback: auto uses the fallback route when the primary is paused; none waits", async () => {
    await start(DEFAULT_CONFIG.replace("  backend:\n    route: slow", "  backend:\n    route: slow\n    fallback: auto\n    fallback_routes: [fast]").replace("routes:\n  fast:\n    vendor: fake", "routes:\n  fast:\n    vendor: fake"));
    h.project.emit("route.paused", { route: "slow", until: "2026-01-05T12:00:00.000Z", source: "user" });
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    expect(h.project.store.runs.listByTask(h.project.id, t.id)[0]?.route).toBe("fast");
  });

  it("cancel-all: harness stop leaves zero child processes", async () => {
    await start();
    s.scripts.set("T-001", byMode({ steps: [{ kind: "spawn_child" }, { kind: "hang" }] }));
    s.scripts.set("T-002", byMode({ steps: [{ kind: "spawn_child" }, { kind: "hang" }] }));
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.project.createTask({ title: "B", role: "frontend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => h.project.store.runs.listActive(h.project.id).filter((r) => r.pid).length === 2, 10_000, "two live runs");
    const pids = h.project.store.runs.listActive(h.project.id).map((r) => r.pid!);
    const children: number[] = [];
    await waitFor(() => {
      children.length = 0;
      for (const e of h.project.store.events.list({ projectId: h.project.id, types: ["run.event"] })) {
        if (e.type === "run.event" && e.payload.event.type === "message") {
          const raw = e.payload.event.raw as { pid?: number } | undefined;
          if (raw?.pid) children.push(raw.pid);
        }
      }
      return children.length === 2;
    }, 5000, "grandchildren");
    for (const pid of [...pids, ...children]) expect(pidAlive(pid)).toBe(true);
    await h.daemon.stop("test");
    for (const pid of [...pids, ...children]) expect(pidAlive(pid)).toBe(false);
    expect(a).toBeDefined();
    h = undefined as never;
  });

  it("masks secrets in stored agent output", async () => {
    await start();
    process.env.TEST_SERVICE_TOKEN = "tok-very-secret-value-123";
    s.scripts.set("T-001", byMode({ steps: [{ kind: "message", text: "found tok-very-secret-value-123 and ghp_abcdefghijklmnopqrstuvwxyz012345" }, ...writes({ "src/server/a.ts": "a\n" }).steps] }));
    await h.stop();
    s.cleanup();
    await start();
    s.scripts.set("T-001", byMode({ steps: [{ kind: "message", text: "found tok-very-secret-value-123 and ghp_abcdefghijklmnopqrstuvwxyz012345" }, ...writes({ "src/server/a.ts": "a\n" }).steps] }));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const all = JSON.stringify(h.project.store.events.list({ projectId: h.project.id }));
    expect(all).not.toContain("tok-very-secret-value-123");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(all).toContain("found [masked] and [masked]");
    const run = h.project.store.runs.listByTask(h.project.id, t.id)[0]!;
    expect(fs.readFileSync(path.join(s.repo.root, run.artifactDir, "events.jsonl"), "utf8")).not.toContain("tok-very-secret");
    delete process.env.TEST_SERVICE_TOKEN;
  });
});
