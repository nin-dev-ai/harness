import { describe, expect, it } from "vitest";
import { parseBudget } from "./engine.js";
import { dependencyDepth, filesOverlap, selectWork } from "./scheduler.js";
import type { HarnessConfig, Task } from "@harness/core";

describe("limits set parsing", () => {
  it("parses caps and budgets", () => {
    expect(parseBudget("5h", "85%")).toEqual({ key: "window_5h_cap_pct", value: 85 });
    expect(parseBudget("7d", "80")).toEqual({ key: "window_7d_cap_pct", value: 80 });
    expect(parseBudget("budget", "40 runs/day")).toEqual({ key: "manual_budget", value: { unit: "runs", per: "day", amount: 40 } });
    expect(parseBudget("budget", "120 minutes/week")).toEqual({ key: "manual_budget", value: { unit: "minutes", per: "week", amount: 120 } });
    expect(() => parseBudget("5h", "lots")).toThrow();
    expect(() => parseBudget("budget", "40 per day")).toThrow();
  });
});

const task = (id: string, o: Partial<Task> = {}): Task => ({
  id, projectId: "p", title: id, role: "backend", state: "QUEUED", size: "M", dependsOn: [], attempts: 0, attemptsMax: 3,
  branch: null, worktree: null, specPath: "", blockedReason: null, createdAt: `2026-01-01T00:00:0${id.slice(-1)}Z`, updatedAt: "", ...o,
});

describe("scheduler selection", () => {
  const cfg = {} as HarnessConfig;
  it("orders in-flight work first, then depth, size and age; skips unmerged dependencies", () => {
    const tasks = [
      task("T-001", { size: "L" }),
      task("T-002", { size: "S" }),
      task("T-003", { dependsOn: ["T-001"] }),
      task("T-004", { state: "REPAIRING" }),
      task("T-005", { state: "REVIEWING" }),
      task("T-006", { state: "PAUSED" }),
    ];
    const items = selectWork({ config: cfg, tasks, live: new Set(), pauseCause: () => "limit", filesHint: () => [], reviewerRole: "reviewer" });
    expect(items.map((i) => `${i.task.id}:${i.kind}`)).toEqual(["T-004:repair", "T-005:review", "T-006:resume", "T-001:implement", "T-002:implement"]);
    expect(dependencyDepth(tasks).get("T-001")).toBe(1);
  });
  it("leaves user-paused tasks alone and respects filters", () => {
    const tasks = [task("T-001", { state: "PAUSED" }), task("T-002", { role: "frontend" })];
    expect(selectWork({ config: cfg, tasks, live: new Set(), pauseCause: () => "user", filesHint: () => [], reviewerRole: undefined, onlyRole: "backend" })).toEqual([]);
  });
  it("detects overlapping file hints", () => {
    expect(filesOverlap(["src/ui/**"], ["src/ui/a.ts"])).toBe(true);
    expect(filesOverlap(["src/ui/a.ts"], ["src/server/a.ts"])).toBe(false);
    expect(filesOverlap([], ["x"])).toBe(false);
  });
});
