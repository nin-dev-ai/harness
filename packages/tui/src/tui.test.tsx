import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { App } from "./App.js";
import { Output } from "./components/Output.js";
import { Tasks } from "./components/Tasks.js";
import { UsageBar } from "./components/UsageBar.js";
import { Workers } from "./components/Workers.js";
import { Help } from "./components/Help.js";
import { ReviewView } from "./components/ReviewView.js";
import { TuiStore, type TuiApi } from "./store.js";

const NOW = "2026-01-05T12:41:00.000Z";

const snap: StatusSnapshot = {
  project: { id: "market-terminal-abc123", name: "market-terminal", root: "/repo", integrationBranch: "harness/integration", autonomy: "approved-scope" },
  scheduler: { running: true, until: null, burst: true },
  now: NOW,
  workers: [
    { id: "frontend-1", projectId: "p", role: "frontend", state: "RUNNING", currentRun: "R-T-004-1", heartbeatAt: null, waitingReason: null, vendor: "codex", route: "codex-sub", taskId: "T-004", taskTitle: "Watchlist panel", runKind: "initial", elapsedMs: 12 * 60_000 },
    { id: "backend-1", projectId: "p", role: "backend", state: "RUNNING", currentRun: "R-T-005-1", heartbeatAt: null, waitingReason: null, vendor: "claude", route: "claude-sub", taskId: "T-005", taskTitle: "Quote feed adapter", runKind: "initial", elapsedMs: 7 * 60_000 },
    { id: "reviewer-1", projectId: "p", role: "reviewer", state: "PAUSED", currentRun: null, heartbeatAt: null, waitingReason: "T-004 gate", vendor: "cursor", route: "cursor-key", taskId: null, taskTitle: null, runKind: null, elapsedMs: null },
  ],
  tasks: [
    { id: "T-003", projectId: "p", title: "Quote contract", role: "backend", state: "PR_READY", size: "S", dependsOn: [], attempts: 1, attemptsMax: 3, branch: "harness/backend/T-003-quote-contract", worktree: null, specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: "R-T-003-2" },
    { id: "T-004", projectId: "p", title: "Watchlist panel", role: "frontend", state: "RUNNING", size: "M", dependsOn: [], attempts: 1, attemptsMax: 3, branch: "harness/frontend/T-004-watchlist", worktree: ".harness/worktrees/T-004", specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: "R-T-004-1" },
    { id: "T-006", projectId: "p", title: "Wire panel to feed", role: "frontend", state: "QUEUED", size: "M", dependsOn: ["T-004", "T-005"], attempts: 0, attemptsMax: 3, branch: null, worktree: null, specPath: "", blockedReason: "dependencies", createdAt: NOW, updatedAt: NOW, lastRunId: null },
    { id: "T-007", projectId: "p", title: "Docs", role: "backend", state: "DRAFT", size: "S", dependsOn: [], attempts: 0, attemptsMax: 3, branch: null, worktree: null, specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: null },
  ],
  routes: [
    { route: "claude-sub", vendor: "claude", auth: "subscription", model: null, pausedUntil: null, pauseSource: null, windows: [
      { route: "claude-sub", vendor: "claude", kind: "5h", usedPct: 78, display: "78%", resetsAt: "2026-01-05T14:05:00.000Z", source: "vendor", observedAt: NOW, stale: false, capPct: 85 },
      { route: "claude-sub", vendor: "claude", kind: "7d", usedPct: 31, display: "31%", resetsAt: "2026-01-09T09:00:00.000Z", source: "vendor", observedAt: NOW, stale: false, capPct: 80 },
    ] },
    { route: "codex-sub", vendor: "codex", auth: "subscription", model: null, pausedUntil: "2026-01-05T15:30:00.000Z", pauseSource: "event", windows: [] },
    { route: "cursor-key", vendor: "cursor", auth: "api_key", model: null, pausedUntil: null, pauseSource: null, windows: [
      { route: "cursor-key", vendor: "cursor", kind: "budget", usedPct: 27.5, display: "28%", resetsAt: null, source: "manual", observedAt: NOW, stale: false, capPct: 100 },
    ] },
  ],
  approvals: [],
  warnings: [],
};

describe("panels", () => {
  it("usage bar shows sources, caps, unknown and pauses", () => {
    const f = render(<UsageBar routes={snap.routes} now={NOW} width={160} />).lastFrame()!;
    expect(f).toContain("USAGE");
    expect(f).toContain("78%");
    expect(f).toContain("cap 85%");
    expect(f).toContain("[vendor]");
    expect(f).toContain("[manual]");
    expect(f).toContain("5h unknown");
    expect(f).not.toMatch(/codex-sub.*\b0%/);
    expect(f).toContain("paused until");
    expect(f).toMatchSnapshot();
  });

  it("workers, tasks and output render", () => {
    expect(render(<Workers workers={snap.workers} selected={0} focused width={50} />).lastFrame()).toMatchSnapshot();
    const tasks = render(<Tasks tasks={snap.tasks} selected={1} focused={false} width={60} height={10} />).lastFrame()!;
    expect(tasks).toContain("T-006 QUEUED");
    expect(tasks).toContain("(dependencies)");
    expect(tasks).toMatchSnapshot();
    const out = render(<Output title="frontend-1 (codex) · T-004" lines={["› editing src/panels/Watchlist.tsx", "› tool: shell pnpm test watchlist", "✗ check unit (3.1s)"]} height={6} width={70} scroll={0} raw={false} />).lastFrame()!;
    expect(out).toContain("OUTPUT: frontend-1 (codex) · T-004");
    expect(out).toMatchSnapshot();
    expect(render(<Help />).lastFrame()).toContain("quit the UI (daemon keeps running)");
    expect(render(<ReviewView data={{ task: { id: "T-003", title: "Quote contract", state: "PR_READY" }, stat: " a.ts | 2 +-", diff: null, checks: [{ checkId: "unit", ok: true, required: true }], gate: "gate.passed", findings: [{ severity: "nit", file: "a.ts", line: 3, message: "rename" }] }} showDiff={false} width={80} height={20} />).lastFrame()).toMatchSnapshot();
  });
});

function fakeApi() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const listeners = new Set<(e: HarnessEvent) => void>();
  const api: TuiApi = {
    call: async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, ...(params ? { params } : {}) });
      if (method === "status") return snap as T;
      if (method === "logs") return { events: [] } as T;
      if (method === "review.show") return { task: snap.tasks[0], stat: "", diff: "", checks: [], gate: "gate.passed", findings: [] } as T;
      return {} as T;
    },
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    subscribe: async () => undefined,
  };
  return { api, calls, emit: (e: HarnessEvent) => listeners.forEach((l) => l(e)) };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("app", () => {
  it("renders the layout, streams output, and keys call the daemon", async () => {
    const { api, calls, emit } = fakeApi();
    const store = new TuiStore(api);
    await store.start();
    const onExit = vi.fn();
    const ui = render(<App store={store} onExit={onExit} size={{ columns: 140, rows: 30 }} />);
    await flush();
    emit({ ts: NOW, projectId: "p", type: "run.event", runId: "R-T-004-1", taskId: "T-004", workerId: "frontend-1", payload: { event: { type: "tool_call", runId: "R-T-004-1", tool: "shell", summary: "pnpm test watchlist" } } } as HarnessEvent);
    await flush();
    const frame = ui.lastFrame()!;
    expect(frame).toContain("harness · market-terminal");
    expect(frame).toContain("WORKERS");
    expect(frame).toContain("TASKS");
    expect(frame).toContain("OUTPUT: frontend-1 (codex) · T-004");
    expect(frame).toContain("› tool: shell pnpm test watchlist");
    expect(frame).toContain("q quit · Q stop");

    ui.stdin.write("r");
    await flush();
    expect(calls.some((c) => c.method === "run")).toBe(true);
    ui.stdin.write("p");
    await flush();
    expect(calls.find((c) => c.method === "pause")?.params).toEqual({ task: "T-004" });
    ui.stdin.write("b");
    await flush();
    expect(calls.find((c) => c.method === "burst.set")?.params).toEqual({ enabled: false });

    // Approve a draft from the tasks panel.
    ui.stdin.write("\t");
    await flush();
    for (let i = 0; i < 3; i++) {
      ui.stdin.write("\u001B[B");
      await flush();
    }
    ui.stdin.write("a");
    await flush();
    expect(calls.find((c) => c.method === "task.approve")?.params).toEqual({ ids: ["T-007"] });

    ui.stdin.write("?");
    await flush();
    expect(ui.lastFrame()).toContain("Keys");
    ui.stdin.write("\u001B");
    await flush();

    // q closes the UI only: no stop call reaches the daemon.
    ui.stdin.write("q");
    await flush();
    expect(onExit).toHaveBeenCalledWith({ action: "quit" });
    expect(calls.some((c) => c.method === "daemon.stop" || c.method === "stop")).toBe(false);
    store.stop();
  });

  it("a on a running worker exits to attach; Q asks to stop everything", async () => {
    const { api } = fakeApi();
    const store = new TuiStore(api);
    await store.start();
    const onExit = vi.fn();
    const ui = render(<App store={store} onExit={onExit} size={{ columns: 140, rows: 30 }} />);
    await flush();
    ui.stdin.write("a");
    await flush();
    expect(onExit).toHaveBeenCalledWith({ action: "attach", target: "frontend-1" });
    const ui2 = render(<App store={store} onExit={onExit} size={{ columns: 140, rows: 30 }} />);
    await flush();
    ui2.stdin.write("Q");
    await flush();
    expect(onExit).toHaveBeenLastCalledWith({ action: "stop" });
    store.stop();
    ui.unmount();
    ui2.unmount();
  });

  it("creates a task and sets a limit through forms", async () => {
    const { api, calls } = fakeApi();
    const store = new TuiStore(api);
    await store.start();
    const ui = render(<App store={store} onExit={() => undefined} size={{ columns: 140, rows: 30 }} />);
    await flush();
    ui.stdin.write("n");
    await flush();
    for (const c of "Add tests") ui.stdin.write(c);
    await flush();
    ui.stdin.write("\r");
    await flush();
    expect(calls.find((c) => c.method === "task.add")?.params).toEqual({ title: "Add tests", role: "frontend" });
    ui.stdin.write("l");
    await flush();
    expect(ui.lastFrame()).toContain("LIMITS codex-sub");
    for (const c of "70%") ui.stdin.write(c);
    await flush();
    ui.stdin.write("\r");
    await flush();
    expect(calls.find((c) => c.method === "limits.set")?.params).toEqual({ route: "codex-sub", window: "5h", budget: "70%" });
    ui.unmount();
    store.stop();
  });
});
