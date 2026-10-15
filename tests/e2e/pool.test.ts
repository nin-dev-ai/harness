import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, type UsageSnapshot } from "@harness/core";
import { parseHarnessConfig } from "@harness/config";
import { PolicyGuard, QuotaGuard } from "@harness/daemon";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M21: one role, several subscriptions; work goes where there is room. */
const T0 = "2026-01-05T09:00:00.000Z";
const CONFIG = `version: 1
project: demo
routes:
  fast: { vendor: fake, auth: api_key }
  slow: { vendor: fake, auth: api_key }
  rev: { vendor: fake, auth: api_key }
roles:
  backend: { route: slow, pool: [fast], concurrency: 2, paths_allow: ["src/server/**"] }
  reviewer: { route: rev, mode: readonly }
limits:
  max_parallel_workers: 4
burst:
  resume_jitter_seconds: [0, 0]
  cold_cost_pct: { S: 6, M: 15, L: 25 }
`;
const usage = (route: string, usedPct: number): UsageSnapshot => ({ route, window: "5h", usedPct, resetsAt: "2026-01-05T12:00:00.000Z", source: "vendor", observedAt: T0 });

describe("subscription pool", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });
  const start = async (slowPct: number, fastPct: number) => {
    s = createScenario({ config: CONFIG });
    s.adapterFactory("slow");
    s.adapterFactory("fast");
    h = await startHarness(s, { clock: new FakeClock(T0), guards: (p, _d, kick) => [new PolicyGuard(p, () => true), new QuotaGuard(p, { kick, rng: () => 0 })] });
    s.adapters.get("slow")!.setUsage("slow", [usage("slow", slowPct)]);
    s.adapters.get("fast")!.setUsage("fast", [usage("fast", fastPct)]);
    // Windows are read from the store: refresh both before the first dispatch.
    const q = new QuotaGuard(h.project, { kick: () => undefined });
    await q.refresh("slow", true);
    await q.refresh("fast", true);
    q.dispose();
  };
  const routeOf = (id: string) => h.project.store.runs.listByTask(h.project.id, id).find((r) => r.kind === "initial")?.route;

  it("sends work to the pool member with the most headroom, not just the primary route", async () => {
    await start(70, 20);
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", size: "S", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    expect(routeOf(t.id)).toBe("fast");
  });

  it("when the primary is exhausted, work keeps flowing on the other subscription", async () => {
    await start(97, 50);
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/server/b.ts": "b\n" })));
    const a = h.project.createTask({ title: "A", role: "backend", size: "S", state: "QUEUED" });
    const b = h.project.createTask({ title: "B", role: "backend", size: "S", state: "QUEUED" });
    h.engine.start();
    await h.until(a.id, "MERGED");
    await h.until(b.id, "MERGED");
    expect([routeOf(a.id), routeOf(b.id)]).toEqual(["fast", "fast"]);
  });

  it("uses a signed-in pool member when another subscription is signed out", async () => {
    s = createScenario({ config: CONFIG.replaceAll("auth: api_key", "auth: subscription") });
    s.adapterFactory("slow").setDetect({ installed: true, version: "fake", signedIn: "no", fixHint: "sign in" });
    h = await startHarness(s);
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    expect(routeOf(t.id)).toBe("fast");
    expect(h.project.store.events.list({ projectId: h.project.id, taskId: t.id, types: ["route.selected"] }).find((e) => e.type === "route.selected" && e.payload.route === "fast")?.payload).toMatchObject({ skipped: [{ route: "slow", reason: expect.stringContaining("sign-in no") }] });
  });

  it("reports missing CLIs as a typed blocker without dispatching", async () => {
    s = createScenario({ config: CONFIG.replaceAll("auth: api_key", "auth: subscription") });
    s.adapterFactory("slow").setDetect({ installed: false, signedIn: "unknown", fixHint: "install slow" });
    s.adapterFactory("fast").setDetect({ installed: false, signedIn: "unknown", fixHint: "install fast" });
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.engine.tick();
    expect(h.project.task(t.id).blockedReason).toBe("cli_missing");
    expect(h.project.store.runs.listByTask(h.project.id, t.id)).toHaveLength(0);
  });

  it("a pool may not hold two routes of one vendor", () => {
    const bad = `version: 1
project: demo
routes:
  c1: { vendor: claude, auth: subscription }
  c2: { vendor: claude, auth: subscription }
roles:
  backend: { route: c1, pool: [c2] }
`;
    expect(() => parseHarnessConfig(bad)).toThrow(/more than one route of vendor claude/);
  });

  it("usage is per account: what one project learns about a vendor login informs another", async () => {
    const cfg = (route: string) => `version: 1
project: demo
routes:
  ${route}: { vendor: claude, auth: subscription }
roles:
  backend: { route: ${route}, paths_allow: ["src/server/**"] }
`;
    const account = new Map<string, UsageSnapshot[]>();
    s = createScenario({ config: cfg("claude-sub") });
    h = await startHarness(s, { clock: new FakeClock(T0) });
    s.adapterFactory("claude-sub").setUsage("claude-sub", [{ ...usage("claude-sub", 84) }]);
    const first = new QuotaGuard(h.project, { kick: () => undefined, account });
    await first.refresh("claude-sub", true);
    first.dispose();
    expect(account.get("claude|subscription")?.map((x) => x.usedPct)).toEqual([84]);
    await h.stop();
    s.cleanup();

    s = createScenario({ config: cfg("claude") });
    h = await startHarness(s, { clock: new FakeClock(T0) });
    const second = new QuotaGuard(h.project, { kick: () => undefined, account });
    await second.refresh("claude", true);
    second.dispose();
    expect(h.project.store.windows.list(h.project.id, "claude").map((w) => [w.kind, w.usedPct, w.source])).toEqual([["5h", 84, "vendor"]]);
  });
});

