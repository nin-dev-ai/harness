import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { App } from "./App.js";
import { completions, parseInput } from "./commands.js";
import { TuiStore, type TuiApi } from "./store.js";
import { suggestScope, Wizard, type WizardResult } from "./Wizard.js";

const NOW = "2026-01-05T12:41:00.000Z";
const task = (id: string, title: string, role: string, state: "RUNNING" | "DRAFT" | "QUEUED" | "NEEDS_HUMAN", extra: Record<string, unknown> = {}) => ({
  id, projectId: "p", title, role, state, size: "M" as const, dependsOn: [] as string[], attempts: 1, attemptsMax: 3, branch: null, worktree: null, specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: null, ...extra,
});
const worker = (id: string, role: string, vendor: string, route: string, state: "RUNNING" | "IDLE", taskId: string | null = null) => ({
  id, projectId: "p", role, state, currentRun: taskId ? `R-${taskId}-1` : null, heartbeatAt: null, waitingReason: null, vendor, route, taskId, taskTitle: null, runKind: taskId ? "initial" : null, elapsedMs: taskId ? 12 * 60_000 : null,
});

const snap = (): StatusSnapshot => ({
  project: { id: "p", name: "market-terminal", root: "/repo", integrationBranch: "harness/integration", autonomy: "approved-scope" },
  scheduler: { running: true, until: null, burst: true },
  now: NOW,
  workers: [worker("backend-1", "backend", "claude", "claude-opus", "IDLE"), worker("frontend-1", "frontend", "codex", "codex", "RUNNING", "T-004"), worker("reviewer-1", "reviewer", "cursor", "cursor", "IDLE"), worker("planner-1", "planner", "claude", "claude-opus", "IDLE")],
  tasks: [task("T-004", "Watchlist panel", "frontend", "RUNNING", { lastRunId: "R-T-004-1", branch: "harness/frontend/T-004-watchlist" }), task("T-005", "Quote feed", "backend", "QUEUED"), task("T-006", "Old bug", "backend", "NEEDS_HUMAN", { needsHumanReason: "stalled: same failure twice" }), task("T-007", "Docs", "backend", "DRAFT")],
  routes: [
    { route: "claude-opus", vendor: "claude", auth: "subscription", model: "opus", pausedUntil: null, pauseSource: null, windows: [{ route: "claude-opus", vendor: "claude", kind: "5h", usedPct: 62, display: "62%", resetsAt: "2026-01-05T14:05:00.000Z", source: "vendor", observedAt: NOW, stale: false, capPct: 100 }] },
    { route: "codex", vendor: "codex", auth: "subscription", model: null, pausedUntil: null, pauseSource: null, windows: [] },
    { route: "cursor", vendor: "cursor", auth: "api_key", model: null, pausedUntil: null, pauseSource: null, windows: [] },
  ],
  approvals: [],
  warnings: [],
});

function fakeApi() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(e: HarnessEvent) => void>();
  const api: TuiApi = {
    call: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "status") return snap() as T;
      if (method === "events.list") return [] as T;
      if (method === "task.show") return { spec: { body: "Show a watchlist with FRESH / STALE / DELAYED states", front: { acceptance: ["lists symbols", "freshness states"] } }, runs: [{ id: "R-T-004-1", kind: "initial", state: "RUNNING", route: "codex", checks: [{ checkId: "unit", ok: false }] }] } as T;
      if (method === "review.show") return { task: { id: "T-004", title: "Watchlist panel", state: "RUNNING" }, stat: "", diff: "+added\n-removed", checks: [{ checkId: "unit", ok: false, required: true }], gate: "gate.failed", findings: [], fileStats: [{ path: "src/panels/Watchlist.tsx", insertions: 30, deletions: 4 }] } as T;
      if (method === "task.add") return { id: "T-008" } as T;
      if (method === "task.approve") return { approved: params.all ? ["T-007"] : ((params.ids as string[]) ?? []) } as T;
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

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function setup() {
  const f = fakeApi();
  const store = new TuiStore(f.api);
  await store.start();
  const onExit = vi.fn();
  const ui = render(<App store={store} onExit={onExit} size={{ columns: 130, rows: 30 }} />);
  await flush(700);
  return { ...f, store, ui, onExit };
}

describe("management panel", () => {
  it("shows who is working on what, with tool, model, context and the selected agent's details", async () => {
    const { ui, emit, store } = await setup();
    emit({ ts: NOW, projectId: "p", type: "run.event", runId: "R-T-004-1", taskId: "T-004", workerId: "frontend-1", payload: { event: { type: "tool_call", runId: "R-T-004-1", tool: "shell", summary: "npm test" } } } as HarnessEvent);
    emit({ ts: NOW, projectId: "p", type: "run.event", runId: "R-T-004-1", taskId: "T-004", workerId: "frontend-1", payload: { event: { type: "usage", runId: "R-T-004-1", tokensIn: 48_200, tokensOut: 900, costUsd: 0.42 } } } as HarnessEvent);
    await flush(700);
    const f = ui.lastFrame()!;
    expect(f).toContain("harness · market-terminal");
    expect(f).toContain("claude 5h 62%");
    expect(f).toContain("codex usage unknown");
    expect(f).toContain("1 working · 3 idle");
    expect(f).toContain("1 needs you");
    expect(f).toMatch(/AGENT\s+TOOL\s+STATUS\s+TASK\s+TIME\s+CONTEXT\s+COST/);
    expect(f).toMatch(/▸.frontend-1\s+codex\/default\s+working\s+T-004 Watchlist panel\s+12m\s+48k\s+\$0\.42/);
    expect(f).toMatch(/backend-1\s+claude\/opus\s+idle\s+next: T-005 Quote feed/);
    expect(f).toContain("── frontend-1 · T-004 Watchlist panel");
    expect(f).toContain("Show a watchlist with FRESH / STALE / DELAYED states");
    expect(f).toContain("· lists symbols");
    expect(f).toContain("src/panels/Watchlist.tsx +30 -4");
    expect(f).toContain("last gate: ✗ unit   attempt 1/3");
    expect(f).toContain("now");
    expect(f).toContain("shell npm test");
    expect(f).toContain("T-006 needs you");
    expect(f).toContain("1 draft (/approve all)");
    expect(f).not.toContain("⏺"); // no chat stream here
    store.stop();
  });

  it("arrow keys select agents; enter opens the review; d the diff; esc closes", async () => {
    const { ui, store } = await setup();
    ui.stdin.write("\u001B[B");
    await flush(300);
    expect(ui.lastFrame()).toContain("── backend-1 · T-005 Quote feed");
    expect(ui.lastFrame()).toContain("(up next)");
    ui.stdin.write("\u001B[A");
    await flush();
    ui.stdin.write("\r");
    await flush();
    expect(ui.lastFrame()).toContain("review T-004 Watchlist panel");
    expect(ui.lastFrame()).toContain("✗ unit");
    ui.stdin.write("\u001B");
    await flush();
    ui.stdin.write("d");
    await flush();
    expect(ui.lastFrame()).toContain("diff T-004");
    expect(ui.lastFrame()).toContain("+added");
    store.stop();
  });

  it("/ opens a command line with completion; commands call the daemon", async () => {
    const { ui, calls, store } = await setup();
    ui.stdin.write("/");
    await flush();
    ui.stdin.write("ap");
    await flush();
    expect(ui.lastFrame()).toContain("/approve");
    ui.stdin.write("\t");
    await flush();
    ui.stdin.write("all\r");
    await flush();
    expect(calls.find((c) => c.method === "task.approve")?.params).toEqual({ all: true });
    expect(ui.lastFrame()).toContain("approved T-007");
    ui.stdin.write("/");
    await flush();
    ui.stdin.write("task Add health check @backend\r");
    await flush();
    expect(calls.find((c) => c.method === "task.add")?.params).toEqual({ title: "Add health check", role: "backend", approve: true });
    ui.stdin.write("/");
    await flush();
    ui.stdin.write("msg use a constant\r");
    await flush();
    expect(calls.find((c) => c.method === "agent.message")?.params).toEqual({ target: "T-004", text: "use a constant" });
    ui.stdin.write("p");
    await flush();
    expect(calls.find((c) => c.method === "pause")?.params).toEqual({ task: "T-004" });
    store.stop();
  });

  it("q closes the panel without stopping agents; /stop stops", async () => {
    const a = await setup();
    a.ui.stdin.write("q");
    await flush();
    expect(a.onExit).toHaveBeenCalledWith({ action: "quit" });
    expect(a.calls.some((c) => c.method === "daemon.stop" || c.method === "stop")).toBe(false);
    a.store.stop();
    const b = await setup();
    b.ui.stdin.write("/");
    await flush();
    b.ui.stdin.write("stop\r");
    await flush();
    expect(b.onExit).toHaveBeenCalledWith({ action: "stop" });
    b.store.stop();
  });
});

describe("setup wizard", () => {
  it("walks tools, agents and per-agent settings, then returns the choices", async () => {
    let result: WizardResult[] | null = null;
    const ui = render(
      <Wizard
        project="shop"
        tools={[{ vendor: "claude", installed: true, signedIn: "yes", version: "2.1" }, { vendor: "codex", installed: true, signedIn: "yes", version: "0.16" }, { vendor: "cursor", installed: false, signedIn: "unknown", fixHint: "install it" }]}
        folders={["src", "src/server", "src/ui", "docs"]}
        onDone={(a) => (result = a)}
        onCancel={() => (result = null)}
      />,
    );
    await flush();
    expect(ui.lastFrame()).toContain("✓ claude");
    expect(ui.lastFrame()).toContain("not installed  → install it");
    ui.stdin.write("\r");
    await flush();
    expect(ui.lastFrame()).toContain("which agents do you want?");
    expect(ui.lastFrame()).toContain("[x] backend");
    // turn on "tests", add a custom "infra" agent
    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write(" ");
    await flush();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write("\u001B[B");
      await flush();
    }
    ui.stdin.write("infra");
    await flush();
    ui.stdin.write("\r");
    await flush();
    expect(ui.lastFrame()).toContain("[x] infra");
    ui.stdin.write("\r");
    await flush();
    expect(ui.lastFrame()).toContain("agent 1 of 6: backend");
    expect(ui.lastFrame()).toContain("◂ claude ▸");
    expect(ui.lastFrame()).toContain("src/server/**");
    ui.stdin.write("\u001B[B"); // model
    await flush();
    ui.stdin.write("opus");
    await flush();
    for (let i = 0; i < 6; i++) {
      ui.stdin.write("\r");
      await flush();
    }
    expect(ui.lastFrame()).toContain("ready");
    expect(ui.lastFrame()).toContain("claude/opus");
    ui.stdin.write("\r");
    await flush();
    expect(result).not.toBeNull();
    const r = result as unknown as WizardResult[];
    expect(r.map((a) => [a.role, a.vendor, a.mode])).toEqual([
      ["backend", "claude", "write"],
      ["frontend", "codex", "write"],
      ["tests", "claude", "write"],
      ["infra", "codex", "write"],
      ["reviewer", "codex", "readonly"],
      ["planner", "claude", "readonly"],
    ]);
    expect(r[0]).toMatchObject({ model: "opus", pathsAllow: ["src/server/**"], concurrency: 1 });
  });

  it("suggests write scopes from the repo's folders", () => {
    expect(suggestScope("frontend", ["src", "web"])).toBe("web/**");
    expect(suggestScope("backend", ["api", "src"])).toBe("api/**");
    expect(suggestScope("infra", ["src"])).toBe("src/**");
    expect(suggestScope("docs", [])).toBe("docs/**, **/*.md");
  });

  it("parses commands", () => {
    expect(parseInput("/approve all")).toEqual({ kind: "command", name: "approve", args: "all", known: true });
    expect(parseInput("rev T-4")).toMatchObject({ name: "review", known: true });
    expect(completions("").length).toBeGreaterThan(10);
    expect(completions("ta").map((c) => c.name)).toEqual(["task", "tasks"]);
  });
});
