import { describe, expect, it } from "vitest";
import { ChecksConfigSchema, HarnessConfigSchema } from "./config.js";
import { HarnessEventSchema, makeEvent } from "./events.js";
import { TaskFrontMatterSchema } from "./task.js";
import { AgentEventSchema } from "./run.js";
import { formatUsedPct, isStale } from "./window.js";

const minimal = {
  version: 1,
  project: "demo",
  routes: { "claude-sub": { vendor: "claude", auth: "subscription" } },
  roles: { backend: { route: "claude-sub" } },
};

describe("config schemas", () => {
  it("applies defaults", () => {
    const c = HarnessConfigSchema.parse(minimal);
    expect(c.integration_branch).toBe("harness/integration");
    expect(c.limits.max_attempts_per_task).toBe(3);
    expect(c.burst.cold_cost_pct).toEqual({ S: 6, M: 12, L: 25 });
    expect(c.roles.backend?.mode).toBe("write");
    expect(c.policy.autonomy).toBe("approved-scope");
  });
  it("rejects unknown keys", () => {
    expect(HarnessConfigSchema.safeParse({ ...minimal, rolez: {} }).success).toBe(false);
    expect(HarnessConfigSchema.safeParse({ ...minimal, roles: { backend: { route: "claude-sub", concurency: 2 } } }).success).toBe(false);
  });
  it("validates checks.yaml", () => {
    const c = ChecksConfigSchema.parse({ version: 1, checks: [{ id: "unit", argv: ["pnpm", "test"] }] });
    expect(c.checks[0]?.required).toBe(true);
    expect(c.env_pass).toEqual(["CI", "NODE_ENV"]);
    expect(ChecksConfigSchema.safeParse({ version: 1, checks: [{ id: "unit", argv: [] }] }).success).toBe(false);
  });
  it("validates task front matter", () => {
    const t = TaskFrontMatterSchema.parse({ id: "T-004", title: "x", role: "frontend" });
    expect(t.state).toBe("DRAFT");
    expect(TaskFrontMatterSchema.safeParse({ id: "4", title: "x", role: "f" }).success).toBe(false);
  });
});

describe("events", () => {
  it("builds and validates typed events", () => {
    const e = makeEvent("task.state_changed", { from: "QUEUED", to: "RUNNING" }, { ts: "2026-01-01T00:00:00Z", projectId: "p", taskId: "T-001" });
    expect(HarnessEventSchema.parse(e)).toEqual(e);
  });
  it("rejects a bad payload", () => {
    expect(() => makeEvent("task.state_changed", { from: "NOPE" as never, to: "RUNNING" }, { ts: "t", projectId: "p" })).toThrow();
    expect(HarnessEventSchema.safeParse({ ts: "t", projectId: "p", type: "made.up", payload: {} }).success).toBe(false);
  });
  it("wraps agent events", () => {
    const ev = AgentEventSchema.parse({ type: "rate_limit", runId: "R-T-001-1", window: "5h", resetsAt: "2026-01-01T05:00:00Z" });
    const e = makeEvent("run.event", { event: ev }, { ts: "t", projectId: "p" });
    expect(HarnessEventSchema.safeParse(e).success).toBe(true);
  });
});

describe("windows", () => {
  it("never renders unknown as zero", () => {
    expect(formatUsedPct(null)).toBe("unknown");
    expect(formatUsedPct(0)).toBe("0%");
  });
  it("marks readings older than 10 minutes stale", () => {
    expect(isStale("2026-01-01T00:00:00Z", new Date("2026-01-01T00:10:01Z"))).toBe(true);
    expect(isStale("2026-01-01T00:00:00Z", new Date("2026-01-01T00:09:59Z"))).toBe(false);
  });
});
