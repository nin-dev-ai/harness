import { afterEach, describe, expect, it } from "vitest";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M23: finished work reaches your branch only when you land it. */
describe("land", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });

  it("merged work stays on the integration branch until you land it", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode(writes({ "src/server/feed.ts": "feed\n" })));
    const t = h.project.createTask({ title: "Feed", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    expect(s.repo.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/server/feed.ts");
    const ctx = { attended: true, subscribe: () => () => undefined };
    const r = await h.daemon.handlers().land!({ projectId: h.project.id }, ctx);
    expect(r).toMatchObject({ status: "landed", mode: "fast-forward", commits: 1, into: "main" });
    expect(s.repo.git("ls-tree", "-r", "--name-only", "main")).toContain("src/server/feed.ts");
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["integration.landed"] })).toHaveLength(1);
    expect(await h.daemon.handlers().land!({ projectId: h.project.id }, ctx)).toMatchObject({ status: "nothing" });
  });
});
