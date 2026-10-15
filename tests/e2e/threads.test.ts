import { afterEach, describe, expect, it } from "vitest";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

describe("durable chat turns", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => { await h?.stop(); s?.cleanup(); });
  const ctx = { attended: true, subscribe: () => () => undefined };

  it("continues a delivered request in the same native session", async () => {
    s = createScenario({ config: DEFAULT_CONFIG.replace("land: manual", "land: auto") });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({ ...writes({ "src/server/one.ts": "one\n" }), sessionId: "native-1" }));
    s.scripts.set("T-002", byMode(writes({ "src/server/two.ts": "two\n" })));
    const dispatch = h.daemon.handlers().dispatch!;
    const first = await dispatch({ projectId: h.project.id, document: "Build src/server/one.ts" }, ctx) as { threadId: string };
    await h.until("T-001", "MERGED");
    await h.engine.idle();
    const second = await dispatch({ projectId: h.project.id, document: "Now build src/server/two.ts" }, ctx) as { threadId: string };
    await h.until("T-002", "MERGED");
    await h.engine.idle();
    expect(second.threadId).toBe(first.threadId);
    expect(s.adapters.get("slow")!.requests.find((r) => r.runId === "R-T-002-1")?.resumeSessionId).toBe("native-1");
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: "T-002", types: ["thread.continuity"] }).at(-1)?.payload).toMatchObject({ carrier: "native_resume", route: "slow" });
    expect((await h.daemon.handlers()["thread.status"]!({ projectId: h.project.id }, ctx) as { state: string }[])[0]?.state).toBe("DELIVERED");
  });

  it("hands off bounded context when the primary route is paused", async () => {
    s = createScenario({ config: DEFAULT_CONFIG.replace("land: manual", "land: auto").replace("route: slow\n", "route: slow\n    pool: [fast]\n") });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({ ...writes({ "src/server/one.ts": "one\n" }), sessionId: "native-1" }));
    s.scripts.set("T-002", byMode(writes({ "src/server/two.ts": "two\n" })));
    const dispatch = h.daemon.handlers().dispatch!;
    await dispatch({ projectId: h.project.id, document: "Build src/server/one.ts" }, ctx);
    await h.until("T-001", "MERGED");
    await h.engine.idle();
    h.project.emit("route.paused", { route: "slow", until: "2026-01-05T12:00:00Z", source: "user" });
    await dispatch({ projectId: h.project.id, document: "Now build src/server/two.ts" }, ctx);
    await h.until("T-002", "MERGED");
    const req = s.adapters.get("fast")!.requests.find((r) => r.runId === "R-T-002-1")!;
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.prompt).toContain("## Conversation handoff");
    expect(req.prompt).toContain("Build src/server/one.ts");
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: "T-002", types: ["thread.continuity"] }).at(-1)?.payload).toMatchObject({ carrier: "handoff", route: "fast", fromRoute: "slow" });
  });
});
