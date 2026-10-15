import { afterEach, describe, expect, it } from "vitest";
import { sizeOfRequest } from "@harness/planner";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M22: a route's model tier follows the task's size. */
const CONFIG = DEFAULT_CONFIG.replace("  slow:\n    vendor: fake\n    auth: api_key\n", "  slow:\n    vendor: fake\n    auth: api_key\n    model: middle\n    models: { S: small, L: big }\n");

describe("model tiers", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });

  it("S and L tasks get their tier, M falls back to the route model, reviews use the default", async () => {
    s = createScenario({ config: CONFIG });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/server/b.ts": "b\n" })));
    s.scripts.set("T-003", byMode(writes({ "src/server/c.ts": "c\n" })));
    const a = h.project.createTask({ title: "Tiny", role: "backend", size: "S", state: "QUEUED" });
    const b = h.project.createTask({ title: "Big", role: "backend", size: "L", state: "QUEUED" });
    const c = h.project.createTask({ title: "Mid", role: "backend", size: "M", state: "QUEUED" });
    h.engine.start();
    for (const t of [a, b, c]) await h.until(t.id, "MERGED");
    const model = (id: string) => s.adapters.get("slow")!.requests.find((r) => r.runId === `R-${id}-1`)!.model;
    expect([model(a.id), model(b.id), model(c.id)]).toEqual(["small", "big", "middle"]);
    const started = h.project.store.events.list({ projectId: h.project.id, taskId: a.id, types: ["run.started"] }).map((e) => (e.payload as { model: string | null }).model);
    expect(started[0]).toBe("small");
  });

  it("sizes a chat request by how much was asked", () => {
    expect(sizeOfRequest("fix the typo in the header")).toBe("S");
    expect(sizeOfRequest(Array(100).fill("word").join(" "))).toBe("M");
    expect(sizeOfRequest(Array(400).fill("word").join(" "))).toBe("L");
  });

  it("small tasks skip the reviewer when review_sizes leaves S out", async () => {
    s = createScenario({ config: DEFAULT_CONFIG.replace("  max_attempts_per_task: 3", "  max_attempts_per_task: 3\n  review_sizes: [M, L]") });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/server/b.ts": "b\n" })));
    const small = h.project.createTask({ title: "Typo", role: "backend", size: "S", state: "QUEUED" });
    const mid = h.project.createTask({ title: "Feature", role: "backend", size: "M", state: "QUEUED" });
    h.engine.start();
    await h.until(small.id, "MERGED");
    await h.until(mid.id, "MERGED");
    const reviews = (id: string) => h.project.store.runs.listByTask(h.project.id, id).filter((r) => r.kind === "review").length;
    expect([reviews(small.id), reviews(mid.id)]).toEqual([0, 1]);
  });
});

