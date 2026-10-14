import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, type HarnessEvent, type UsageSnapshot } from "@harness/core";
import { QuotaGuard } from "@harness/daemon";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** Scenario tests for quota windows and the burst scheduler (M9). Fake adapter + fake clock. */

const T0 = "2026-01-05T09:00:00.000Z";

function config(extra: { backendConcurrency?: number; limits?: string; burst?: string } = {}): string {
  return `version: 1
project: demo
routes:
  fast: { vendor: fake, auth: api_key }
  slow: { vendor: fake, auth: subscription }
  rev: { vendor: fake, auth: api_key }
roles:
  frontend: { route: fast, paths_allow: ["src/ui/**"] }
  backend: { route: slow, concurrency: ${extra.backendConcurrency ?? 1}, paths_allow: ["src/server/**"] }
  reviewer: { route: rev, mode: readonly }
limits:
  max_parallel_workers: 4
${extra.limits ?? ""}
burst:
  resume_jitter_seconds: [5, 5]
  cold_cost_pct: { S: 6, M: 15, L: 25 }
${extra.burst ?? ""}
policy:
  unattended: { slow: allow }
`;
}

const usage = (o: Partial<UsageSnapshot> & { window: UsageSnapshot["window"] }): UsageSnapshot => ({ route: "slow", usedPct: 0, resetsAt: null, source: "vendor", observedAt: T0, ...o });

describe("burst and resume", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });

  const start = async (cfg: string, clock = new FakeClock(T0)) => {
    s = createScenario({ config: cfg });
    s.adapterFactory("slow");
    h = await startHarness(s, { clock, guards: (p, _d, kick) => [new QuotaGuard(p, { kick, rng: () => 0 })] });
    return h;
  };
  const ev = (type: HarnessEvent["type"], taskId?: string) => h.project.store.events.list({ projectId: h.project.id, types: [type], ...(taskId ? { taskId } : {}) });

  it("burst-and-resume: fits one task, rejects the second, pauses only that route, resumes at reset with the same session", async () => {
    await start(config({ backendConcurrency: 2 }));
    s.adapters.get("slow")!.setUsage("slow", [usage({ window: "5h", usedPct: 75, resetsAt: "2026-01-05T10:00:00.000Z" })]);
    s.scripts.set("T-001", byMode({
      sessionId: "sess-1",
      steps: [{ kind: "file_change", path: "src/server/a.ts", content: "a\n" }, { kind: "rate_limit", window: "5h", resetsAt: "2026-01-05T10:00:00.000Z" }],
      resumeSteps: writes({ "src/server/a2.ts": "a2\n" }).steps,
    }));
    s.scripts.set("T-002", byMode(writes({ "src/server/b.ts": "b\n" })));
    s.scripts.set("T-003", byMode(writes({ "src/ui/c.ts": "c\n" })));
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    const b = h.project.createTask({ title: "B", role: "backend", state: "QUEUED" });
    const c = h.project.createTask({ title: "C", role: "frontend", state: "QUEUED" });
    h.engine.start();

    await h.until(a.id, "PAUSED");
    const notFit = ev("dispatch.considered", b.id).find((e) => e.type === "dispatch.considered" && e.payload.reason === "would_not_fit");
    expect(notFit).toBeDefined();
    expect(h.project.store.tasks.get(h.project.id, b.id)?.blockedReason).not.toBeNull();

    // Only the limited route pauses; other routes keep working.
    const paused = ev("route.paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.type === "route.paused" && paused[0].payload).toMatchObject({ route: "slow", until: "2026-01-05T10:00:05.000Z", source: "event", window: "5h" });
    await h.until(c.id, "MERGED");
    expect(h.project.task(b.id).state).toBe("QUEUED");
    const ckpt = ev("run.checkpointed", a.id);
    expect(ckpt.length).toBeGreaterThan(0);
    expect(s.repo.git("log", "--format=%s", `harness/integration..${h.project.task(a.id).branch}`)).toContain("wip(T-001): checkpoint R-T-001-1");

    // Nothing runs before the reset (+ jitter).
    h.clock.set("2026-01-05T10:00:04.000Z");
    await h.engine.idle();
    expect(h.project.task(a.id).state).toBe("PAUSED");

    s.adapters.get("slow")!.setUsage("slow", [usage({ window: "5h", usedPct: 2, resetsAt: "2026-01-05T15:00:00.000Z", observedAt: "2026-01-05T10:00:06.000Z" })]);
    h.clock.set("2026-01-05T10:00:06.000Z");
    await h.until(a.id, "MERGED");
    await h.until(b.id, "MERGED");
    const runs = h.project.store.runs.listByTask(h.project.id, a.id).filter((r) => r.kind !== "review");
    expect(runs.map((r) => [r.kind, r.vendorSessionId])).toEqual([["initial", "sess-1"], ["resume", "sess-1"]]);
    expect(s.adapters.get("slow")!.requests.find((r) => r.runId === runs[1]!.id)?.resumeSessionId).toBe("sess-1");
    expect(ev("route.resumed")).toHaveLength(1);
  });

  it("weekly-pacing: a high 7d window stops dispatch even when the 5h window has room", async () => {
    await start(config());
    s.adapters.get("slow")!.setUsage("slow", [
      usage({ window: "5h", usedPct: 10, resetsAt: "2026-01-05T12:00:00.000Z" }),
      usage({ window: "7d", usedPct: 85, resetsAt: "2026-01-07T09:00:00.000Z" }),
    ]);
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => ev("dispatch.considered", a.id).length > 0, 5000);
    const d = ev("dispatch.considered", a.id)[0];
    expect(d?.type === "dispatch.considered" && d.payload).toMatchObject({ dispatched: false, reason: "would_not_fit" });
    expect(h.project.store.runs.listByTask(h.project.id, a.id)).toHaveLength(0);
  });

  it("unknown-quota: no vendor data shows unknown and runs only within the manual budget", async () => {
    await start(config({ limits: "  routes:\n    fast: { manual_budget: { unit: runs, per: day, amount: 2 } }" }));
    for (const id of ["T-001", "T-002", "T-003"]) s.scripts.set(id, byMode(writes({ [`src/ui/${id}.ts`]: "x\n" })));
    const ts = ["A", "B", "C"].map((t) => h.project.createTask({ title: t, role: "frontend", state: "QUEUED" }));
    h.engine.start();
    await h.until(ts[0]!.id, "MERGED");
    await h.until(ts[1]!.id, "MERGED");
    await h.engine.idle();
    expect(h.project.task(ts[2]!.id)).toMatchObject({ state: "QUEUED", blockedReason: "window_exhausted" });
    const routes = (await h.daemon.handlers().usage!({ projectId: h.project.id }, { attended: false, subscribe: () => () => undefined })) as { route: string; windows: { kind: string; usedPct: number | null; display: string; source: string }[] }[];
    const fast = routes.find((r) => r.route === "fast")!;
    expect(fast.windows.find((w) => w.kind === "5h")).toBeUndefined(); // shown as unknown, never 0
    expect(fast.windows.find((w) => w.kind === "budget")).toMatchObject({ usedPct: 100, source: "manual" });
    expect(ev("budget.cap_reached")).toHaveLength(1);
  });

  it("two runs on one route hitting the limit produce one pause", async () => {
    await start(config({ backendConcurrency: 2 }));
    const limit = { steps: [{ kind: "message" as const, text: "x", delayMs: 100 }, { kind: "rate_limit" as const, window: "5h" as const, resetsAt: "2026-01-05T11:00:00.000Z" }] };
    s.scripts.set("T-001", byMode(limit));
    s.scripts.set("T-002", byMode(limit));
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", size: "S" });
    const b = h.project.createTask({ title: "B", role: "backend", state: "QUEUED", size: "S" });
    h.engine.start();
    await h.until(a.id, "PAUSED");
    await h.until(b.id, "PAUSED");
    expect(ev("route.paused")).toHaveLength(1);
    expect(ev("run.checkpointed").length).toBeGreaterThanOrEqual(0);
  });

  it("caps below the vendor's limit are hard ceilings", async () => {
    await start(config({ limits: "  routes:\n    slow: { window_5h_cap_pct: 50 }" }));
    s.adapters.get("slow")!.setUsage("slow", [usage({ window: "5h", usedPct: 55, resetsAt: "2026-01-05T12:00:00.000Z" })]);
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", size: "S" });
    h.engine.start();
    await waitFor(() => ev("budget.cap_reached").length > 0, 5000);
    await h.engine.idle();
    expect(h.project.task(a.id)).toMatchObject({ state: "QUEUED", blockedReason: "window_exhausted" });
  });

  it("quiet hours: no new dispatch", async () => {
    await start(config({ limits: '  quiet_hours: "08:00-10:00"' }));
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", size: "S" });
    h.engine.start();
    await waitFor(() => ev("dispatch.considered", a.id).length > 0, 5000);
    expect(h.project.task(a.id)).toMatchObject({ state: "QUEUED", blockedReason: "policy" });
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    h.clock.set("2026-01-05T10:00:30.000Z");
    await h.until(a.id, "MERGED");
  });

  it("unknown reset time: probes with backoff, then resumes", async () => {
    await start(config());
    let first = true;
    s.scripts.set("T-001", (req) => {
      if (req.mode === "readonly") return { steps: [{ kind: "result", ok: true, structured: { summary: "", findings: [] } }] };
      if (first) {
        first = false;
        return { sessionId: "s", steps: [{ kind: "rate_limit", structured: false }] };
      }
      return { sessionId: "s", steps: writes({ "src/server/a.ts": "a\n" }).steps };
    });
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", size: "S" });
    h.engine.start();
    await h.until(a.id, "PAUSED");
    const p = ev("route.paused")[0];
    expect(p?.type === "route.paused" && p.payload).toMatchObject({ source: "backoff", until: "2026-01-05T09:15:00.000Z", window: "unknown" });
    h.clock.set("2026-01-05T09:15:01.000Z");
    await waitFor(() => ev("probe.sent").length > 0, 5000, "probe");
    await h.until(a.id, "MERGED");
    expect(ev("route.resumed")).toHaveLength(1);
  });

  it("a pause survives a daemon restart", async () => {
    await start(config());
    s.scripts.set("T-001", byMode({ sessionId: "s", steps: [{ kind: "rate_limit", window: "5h", resetsAt: "2026-01-05T11:00:00.000Z" }], resumeSteps: writes({ "src/server/a.ts": "a\n" }).steps }));
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", size: "S" });
    h.engine.start();
    await h.until(a.id, "PAUSED");
    await h.stop();
    const clock = new FakeClock("2026-01-05T10:00:00.000Z");
    h = await startHarness(s, { clock, guards: (p, _d, kick) => [new QuotaGuard(p, { kick, rng: () => 0 })] });
    await h.engine.idle();
    expect(h.project.task(a.id).state).toBe("PAUSED");
    expect(h.project.store.windows.routeState(h.project.id, "slow").pausedUntil).toBe("2026-01-05T11:00:05.000Z");
    clock.set("2026-01-05T11:00:06.000Z");
    await h.until(a.id, "MERGED");
  });

  it("learns task cost from measured window deltas after 3 samples", async () => {
    await start(config());
    let used = 10;
    const fake = s.adapters.get("slow")!;
    fake.setUsage("slow", [usage({ window: "5h", usedPct: used, resetsAt: "2026-01-05T14:00:00.000Z" })]);
    for (const id of ["T-001", "T-002", "T-003", "T-004"]) {
      s.scripts.set(id, (req) => {
        if (req.mode !== "readonly") {
          used += 4;
          fake.setUsage("slow", [usage({ window: "5h", usedPct: used, resetsAt: "2026-01-05T14:00:00.000Z" })]);
        }
        return byMode(writes({ [`src/server/${id}.ts`]: "x\n" }))(req);
      });
    }
    const ts = ["A", "B", "C", "D"].map((t) => h.project.createTask({ title: t, role: "backend", state: "QUEUED", size: "M" }));
    h.engine.start();
    for (const t of ts) await h.until(t.id, "MERGED");
    const samples = h.project.store.windows.costSamples("slow", "backend", "M", "5h");
    expect(samples).toHaveLength(4);
    expect(samples.every((x) => x.deltaPct === 4)).toBe(true);
  });
});
