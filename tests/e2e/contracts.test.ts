import { afterEach, describe, expect, it } from "vitest";
import { PolicyGuard, QuotaGuard } from "@harness/daemon";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** Contract-first tasks and STALE propagation (FR-19). */
describe("contracts", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });

  it("a later change to a contract needs approval and marks merged dependents STALE", async () => {
    s = createScenario();
    h = await startHarness(s, { guards: (p, _d, kick) => [new PolicyGuard(p, () => true), new QuotaGuard(p, { kick })] });
    s.scripts.set("T-001", byMode(writes({ "docs/contracts/quotes.ts": "export type Quote = { px: number };\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/ui/q.ts": "// uses Quote\n" })));
    s.scripts.set("T-003", byMode(writes({ "docs/contracts/quotes.ts": "export type Quote = { px: number; ts: number };\n" })));
    const contract = h.project.createTask({ title: "Quote contract", role: "backend", state: "QUEUED" });
    const consumer = h.project.createTask({ title: "Quote panel", role: "frontend", state: "QUEUED", dependsOn: [contract.id], contractRef: "docs/contracts/quotes.ts" });
    h.engine.start();
    await h.until(consumer.id, "MERGED");
    // Creating the contract did not make the consumer stale.
    expect(h.project.task(consumer.id).state).toBe("MERGED");

    const change = h.project.createTask({ title: "Add timestamp", role: "backend", state: "QUEUED" });
    await h.until(change.id, "PR_READY");
    await h.engine.idle();
    const a = h.project.store.windows.approvals(h.project.id, "PENDING").find((x) => x.taskId === change.id)!;
    expect(a.context).toContain("changes shared contract docs/contracts/quotes.ts used by T-002");
    expect(h.project.task(change.id).state).toBe("PR_READY");

    h.plugin.decide(h.project, a.id, true);
    await h.engine.merge(change.id);
    expect(h.project.task(change.id).state).toBe("MERGED");
    await waitFor(() => h.project.task(consumer.id).state === "STALE", 5000);
    const ev = h.project.store.events.list({ projectId: h.project.id, taskId: consumer.id, types: ["task.state_changed"] }).at(-1);
    expect(ev?.type === "task.state_changed" && ev.payload.reason).toBe("contract docs/contracts/quotes.ts changed by T-003");
  });
});
