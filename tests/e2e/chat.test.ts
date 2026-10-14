import { afterEach, describe, expect, it } from "vitest";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** Messages typed into the chat bar reach the agent working on a task. */
describe("chat with agents", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });

  it("a running agent is stopped at a safe point and resumed on its session with the message", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({
      sessionId: "chat-1",
      steps: [{ kind: "file_change", path: "src/server/a.ts", content: "a\n" }, { kind: "hang" }],
      resumeSteps: writes({ "src/server/b.ts": "b\n" }).steps,
    }));
    const t = h.project.createTask({ title: "Chatty", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => !!h.project.store.runs.listByTask(h.project.id, t.id)[0]?.vendorSessionId, 10_000, "running");
    const r = await h.engine.message("backend-1", "Use a constant for the port, please.");
    expect(r).toEqual({ taskId: t.id, delivery: "now" });
    await h.until(t.id, "MERGED");
    const req = s.adapters.get("slow")!.requests[1]!;
    expect(req.resumeSessionId).toBe("chat-1");
    expect(req.prompt).toContain("> Use a constant for the port, please.");
    expect(h.engine.pendingMessages(t.id)).toEqual([]);
    expect(s.repo.git("ls-tree", "-r", "--name-only", "harness/integration")).toContain("src/server/a.ts");
  });

  it("queued tasks get the message on their first turn; PR_READY work is sent back", async () => {
    s = createScenario({ config: (await import("../helpers/scenario.js")).DEFAULT_CONFIG + "policy:\n  autonomy: assisted\n" });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({ sessionId: "c2", steps: writes({ "src/server/x.ts": "1\n" }).steps, resumeSteps: writes({ "src/server/x.ts": "2\n" }).steps }));
    const t = h.project.createTask({ title: "X", role: "backend", state: "QUEUED" });
    expect((await h.engine.message(t.id, "Keep it tiny.")).delivery).toBe("next-turn");
    h.plugin.approve(h.project, [t.id]);
    h.engine.start();
    await h.until(t.id, "PR_READY");
    expect(s.adapters.get("slow")!.requests[0]!.prompt).toContain("> Keep it tiny.");
    expect((await h.engine.message(t.id, "Rename x to y.")).delivery).toBe("sent-back");
    await waitFor(() => s.adapters.get("slow")!.requests.some((q) => q.prompt.includes("> Rename x to y.")), 10_000, "delivered");
  });
});
