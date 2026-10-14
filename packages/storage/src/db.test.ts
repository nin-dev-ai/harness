import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEvent, type EventPayloadInput, type EventType, type HarnessEvent } from "@harness/core";
import { Store } from "./db.js";
import { migrate } from "./migrate.js";
import { PROJECTION_TABLES } from "./projector.js";

const P = "proj";
let t = Date.parse("2026-01-05T09:00:00Z");
function ev<T extends EventType>(type: T, payload: EventPayloadInput<T>, env: { taskId?: string; runId?: string; workerId?: string } = {}): HarnessEvent {
  t += 1000;
  return makeEvent(type, payload, { ts: new Date(t).toISOString(), projectId: P, ...env }) as HarnessEvent;
}

function seed(store: Store) {
  store.append(ev("project.initialized", { path: "/repo", name: "demo" }));
  store.append(ev("task.created", { title: "Contracts", role: "backend", size: "S", dependsOn: [], state: "DRAFT", specPath: ".harness/tasks/T-001.md" }, { taskId: "T-001" }));
  store.append(ev("task.created", { title: "Panel", role: "frontend", size: "M", dependsOn: ["T-001"], state: "DRAFT", specPath: ".harness/tasks/T-002.md" }, { taskId: "T-002" }));
  for (const to of ["QUEUED", "RUNNING"] as const) store.append(ev("task.state_changed", { from: to === "QUEUED" ? "DRAFT" : "QUEUED", to }, { taskId: "T-001" }));
  store.append(ev("task.updated", { fields: { branch: "harness/backend/T-001-contracts", worktree: ".harness/worktrees/T-001", attempts: 1 } }, { taskId: "T-001" }));
  store.append(ev("worker.state_changed", { role: "backend", from: null, to: "RUNNING", currentRun: "R-T-001-1" }, { workerId: "backend-1" }));
  store.append(ev("run.started", { route: "claude-sub", vendor: "fake", kind: "initial", artifactDir: ".harness/runs/R-T-001-1" }, { taskId: "T-001", runId: "R-T-001-1", workerId: "backend-1" }));
  store.append(ev("run.event", { event: { type: "started", runId: "R-T-001-1", pid: 4242, sessionId: "sess-1" } }, { taskId: "T-001", runId: "R-T-001-1" }));
  store.append(ev("check.finished", { checkId: "unit", ok: false, exitCode: 1, durationMs: 1200, signature: "abc", outputTail: "1 failed" }, { taskId: "T-001", runId: "R-T-001-1" }));
  store.append(ev("run.finished", { state: "SUCCEEDED", exitCode: 0 }, { taskId: "T-001", runId: "R-T-001-1" }));
  store.append(ev("review.finding", { severity: "nit", file: "a.ts", line: 3, message: "rename" }, { taskId: "T-001", runId: "R-T-001-1" }));
  store.append(ev("window.updated", { route: "claude-sub", kind: "5h", usedPct: 40, resetsAt: "2026-01-05T14:00:00Z", source: "vendor" }));
  store.append(ev("route.paused", { route: "claude-sub", until: "2026-01-05T14:01:00Z", source: "event" }));
  store.append(ev("cost.sampled", { route: "claude-sub", role: "backend", size: "S", windowKind: "5h", deltaPct: 7 }, { runId: "R-T-001-1" }));
  store.append(ev("approval.requested", { approvalId: "A-1", category: "protected_paths", context: "edits .github" }, { taskId: "T-002" }));
  store.append(ev("approval.denied", { approvalId: "A-1", comment: "no" }, { taskId: "T-002" }));
  store.append(ev("dispatch.considered", { dispatched: false, reason: "dependencies" }, { taskId: "T-002" }));
  store.append(ev("task.blocked", { reason: "dependencies" }, { taskId: "T-002" }));
}

function snapshot(store: Store) {
  return Object.fromEntries(PROJECTION_TABLES.map((tbl) => [tbl, store.db.prepare(`SELECT * FROM ${tbl} ORDER BY 1, 2`).all()]));
}

describe("Store", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-db-"));
    store = new Store(path.join(dir, "state.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses WAL and applies migrations once", () => {
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(migrate(store.db)).toEqual([]);
  });

  it("projects events into tables", () => {
    seed(store);
    const t1 = store.tasks.get(P, "T-001")!;
    expect(t1).toMatchObject({ state: "RUNNING", branch: "harness/backend/T-001-contracts", attempts: 1 });
    expect(store.tasks.get(P, "T-002")).toMatchObject({ dependsOn: ["T-001"], blockedReason: "dependencies", state: "DRAFT" });
    expect(store.runs.get("R-T-001-1")).toMatchObject({ state: "SUCCEEDED", pid: 4242, vendorSessionId: "sess-1" });
    expect(store.runs.checkResults("R-T-001-1")[0]).toMatchObject({ checkId: "unit", ok: false, signature: "abc" });
    expect(store.runs.findings("R-T-001-1")).toHaveLength(1);
    expect(store.workers.list(P)[0]).toMatchObject({ id: "backend-1", state: "RUNNING" });
    expect(store.windows.list(P)[0]).toMatchObject({ usedPct: 40, pausedUntil: "2026-01-05T14:01:00Z" });
    expect(store.windows.routeState(P, "claude-sub").pausedUntil).toBe("2026-01-05T14:01:00Z");
    expect(store.windows.costSamples("claude-sub", "backend", "S", "5h")).toHaveLength(1);
    expect(store.windows.approvals(P)[0]).toMatchObject({ state: "DENIED", comment: "no" });
    expect(store.runs.nextNumber(P, "T-001")).toBe(2);
  });

  it("rebuilds every projection from the event log alone", () => {
    seed(store);
    const before = snapshot(store);
    for (const tbl of PROJECTION_TABLES) store.db.exec(`DELETE FROM ${tbl}`);
    expect(store.tasks.list(P)).toHaveLength(0);
    store.rebuild();
    expect(snapshot(store)).toEqual(before);
  });

  it("survives reopening the file", () => {
    seed(store);
    store.close();
    store = new Store(path.join(dir, "state.db"));
    expect(store.tasks.list(P)).toHaveLength(2);
    expect(store.events.list({ projectId: P }).length).toBeGreaterThan(10);
  });

  it("rejects invalid events atomically", () => {
    const good = ev("project.initialized", { path: "/r", name: "n" });
    const bad = { ...good, type: "task.state_changed", payload: { from: "NOPE", to: "RUNNING" } } as unknown as HarnessEvent;
    expect(() => store.appendMany([good, bad])).toThrow();
    expect(store.events.lastSeq()).toBe(0);
  });

  it("notifies subscribers with sequence numbers", () => {
    const seen: number[] = [];
    const off = store.subscribe((e) => seen.push(e.seq!));
    store.append(ev("project.initialized", { path: "/r", name: "n" }));
    off();
    store.append(ev("project.initialized", { path: "/r", name: "n" }));
    expect(seen).toEqual([1]);
  });

  it("queries events by task, type and sequence", () => {
    seed(store);
    expect(store.events.list({ projectId: P, taskId: "T-002" }).map((e) => e.type)).toContain("approval.requested");
    expect(store.events.list({ types: ["route.paused"] })).toHaveLength(1);
    expect(store.events.list({ afterSeq: store.events.lastSeq() - 2 })).toHaveLength(2);
    expect(store.events.exists(P, "task.created", "T-001")).toBe(true);
  });
});
