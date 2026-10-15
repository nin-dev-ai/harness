import { afterEach, describe, expect, it } from "vitest";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

describe("bounded delegated jobs", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => { await h?.stop(); s?.cleanup(); });
  const ctx = { attended: true, subscribe: () => () => undefined };

  it("runs isolated children, then resumes the primary to deliver their combined work", async () => {
    s = createScenario({ config: DEFAULT_CONFIG.replace("land: manual", "land: auto").replace("route: slow\n", "route: slow\n    pool: [fast]\n    concurrency: 3\n") });
    h = await startHarness(s);
    const marker = `DELEGATE: ${JSON.stringify({ jobs: [
      { title: "Build first helper", description: "Implement the first server helper", files_hint: ["src/server/first.ts"], acceptance: ["first helper exists"] },
      { title: "Build second helper", description: "Implement the second server helper", files_hint: ["src/server/second.ts"], acceptance: ["second helper exists"] },
    ] })}`;
    s.scripts.set("T-001", byMode({ sessionId: "primary-1", steps: [{ kind: "result", ok: true, summary: marker }], resumeSteps: writes({ "src/server/parent.ts": "integrated\n" }).steps }));
    s.scripts.set("T-002", byMode(writes({ "src/server/first.ts": "first\n" })));
    s.scripts.set("T-003", byMode(writes({ "src/server/second.ts": "second\n" })));
    await h.daemon.handlers().dispatch!({ projectId: h.project.id, document: "Build src/server/parent.ts with two independent helpers" }, ctx);
    await h.until("T-001", "MERGED");
    await h.engine.idle();
    const files = s.repo.git("ls-tree", "-r", "--name-only", "main");
    expect(files).toContain("src/server/first.ts");
    expect(files).toContain("src/server/second.ts");
    expect(files).toContain("src/server/parent.ts");
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: "T-001", types: ["delegation.accepted"] }).at(-1)?.payload).toMatchObject({ childIds: ["T-002", "T-003"] });
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: "T-001", types: ["delegation.resumed"] })).toHaveLength(1);
    expect(s.adapters.get("slow")!.requests.find((r) => r.runId === "R-T-001-2")?.prompt).toContain("## Delegated work completed");
  });

  it("refuses overlapping child jobs with an explicit failure", async () => {
    s = createScenario();
    h = await startHarness(s);
    const job = { title: "Same file", description: "Both would edit the same file", files_hint: ["src/server/same.ts"], acceptance: ["file exists"] };
    s.scripts.set("T-001", byMode({ steps: [{ kind: "result", ok: true, summary: `DELEGATE: ${JSON.stringify({ jobs: [job, job] })}` }] }));
    await h.daemon.handlers().dispatch!({ projectId: h.project.id, document: "Build src/server/same.ts" }, ctx);
    await h.until("T-001", "NEEDS_HUMAN");
    expect(h.project.tasks()).toHaveLength(1);
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: "T-001", types: ["delegation.refused"] }).at(-1)?.payload).toMatchObject({ reason: "child 2 overlaps another child" });
  });

  it("cancels pending children when the primary is cancelled", async () => {
    s = createScenario();
    h = await startHarness(s);
    const jobs = [
      { title: "First helper", description: "Build first helper", files_hint: ["src/server/first.ts"], acceptance: ["first exists"] },
      { title: "Second helper", description: "Build second helper", files_hint: ["src/server/second.ts"], acceptance: ["second exists"] },
    ];
    s.scripts.set("T-001", byMode({ steps: [{ kind: "result", ok: true, summary: `DELEGATE: ${JSON.stringify({ jobs })}` }] }));
    s.scripts.set("T-002", byMode({ steps: [{ kind: "hang" }] }));
    s.scripts.set("T-003", byMode({ steps: [{ kind: "hang" }] }));
    await h.daemon.handlers().dispatch!({ projectId: h.project.id, document: "Build two independent helpers" }, ctx);
    await h.until("T-001", "PAUSED");
    await h.engine.cancelTask("T-001");
    await h.engine.idle();
    expect(h.project.tasks().map((t) => t.state)).toEqual(["CANCELLED", "CANCELLED", "CANCELLED"]);
    expect(h.engine.live.size).toBe(0);
  });
});
