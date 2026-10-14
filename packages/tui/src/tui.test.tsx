import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { App } from "./App.js";
import { completions, parseInput } from "./commands.js";
import { gradient } from "./theme.js";
import { TuiStore, type TuiApi } from "./store.js";
import { Stream } from "./components/Stream.js";
import { THEMES } from "./theme.js";

const NOW = "2026-01-05T12:41:00.000Z";
const task = (id: string, title: string, role: string, state: "RUNNING" | "DRAFT", extra: Record<string, unknown> = {}) => ({
  id, projectId: "p", title, role, state, size: "M" as const, dependsOn: [] as string[], attempts: 1, attemptsMax: 3, branch: null, worktree: null, specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: null, ...extra,
});
const worker = (id: string, role: string, vendor: string, state: "RUNNING" | "IDLE", taskId: string | null = null) => ({
  id, projectId: "p", role, state, currentRun: taskId ? `R-${taskId}-1` : null, heartbeatAt: null, waitingReason: null, vendor, route: `${vendor}-sub`, taskId, taskTitle: taskId ? "Watchlist panel" : null, runKind: taskId ? "initial" : null, elapsedMs: taskId ? 60_000 : null,
});

const snap = (): StatusSnapshot => ({
  project: { id: "p", name: "market-terminal", root: "/repo", integrationBranch: "harness/integration", autonomy: "approved-scope" },
  scheduler: { running: false, until: null, burst: true },
  now: NOW,
  workers: [worker("frontend-1", "frontend", "codex", "RUNNING", "T-004"), worker("backend-1", "backend", "claude", "IDLE"), worker("planner-1", "planner", "claude", "IDLE"), worker("reviewer-1", "reviewer", "cursor", "IDLE")],
  tasks: [task("T-004", "Watchlist panel", "frontend", "RUNNING", { lastRunId: "R-T-004-1" }), task("T-007", "Docs", "backend", "DRAFT")],
  routes: [
    { route: "claude-sub", vendor: "claude", auth: "subscription", model: null, pausedUntil: null, pauseSource: null, windows: [{ route: "claude-sub", vendor: "claude", kind: "5h", usedPct: 62, display: "62%", resetsAt: "2026-01-05T14:05:00.000Z", source: "vendor", observedAt: NOW, stale: false, capPct: 100 }] },
    { route: "cursor-sub", vendor: "cursor", auth: "api_key", model: null, pausedUntil: null, pauseSource: null, windows: [] },
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
      if (method === "review.show") return { task: { id: "T-004", title: "Watchlist panel", state: "RUNNING" }, stat: "", diff: "+added line\n-removed line", checks: [{ checkId: "unit", ok: true, required: true }], gate: "gate.passed", findings: [], fileStats: [{ path: "src/ui/Watchlist.tsx", insertions: 12, deletions: 3 }] } as T;
      if (method === "agent.message") return { taskId: "T-004", delivery: "now" } as T;
      if (method === "task.add") return { id: "T-008" } as T;
      if (method === "task.approve") return { approved: (params.ids as string[] | undefined) ?? [] } as T;
      if (method === "plan") return { summary: "Two steps.", tasks: [{ id: "T-009", title: "Contract", role: "backend" }] } as T;
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
async function type(ui: ReturnType<typeof render>, text: string) {
  ui.stdin.write(text);
  await flush();
}
async function setup() {
  const f = fakeApi();
  const store = new TuiStore(f.api);
  await store.start();
  const onExit = vi.fn();
  const ui = render(<App store={store} onExit={onExit} size={{ columns: 140, rows: 36 }} />);
  await flush();
  return { ...f, store, ui, onExit };
}

describe("chat ui", () => {
  it("renders logo, usage pills, agent tabs, stream, files sidebar, chat bar and status line", async () => {
    const { ui, emit, store } = await setup();
    emit({ ts: NOW, projectId: "p", type: "run.event", runId: "R-T-004-1", taskId: "T-004", workerId: "frontend-1", payload: { event: { type: "tool_call", runId: "R-T-004-1", tool: "Bash", summary: "pnpm test watchlist" } } } as HarnessEvent);
    emit({ ts: NOW, projectId: "p", type: "run.event", runId: "R-T-004-1", taskId: "T-004", workerId: "frontend-1", payload: { event: { type: "file_change", runId: "R-T-004-1", path: "src/ui/Watchlist.tsx" } } } as HarnessEvent);
    await flush(700);
    const f = ui.lastFrame()!;
    expect(f).toContain("✦ harness");
    expect(f).toContain("62%");
    expect(f).toContain("usage unknown");
    expect(f).toContain("frontend-1");
    expect(f).toContain("⏺ Bash(pnpm test watchlist)");
    expect(f).toContain("✎ src/ui/Watchlist.tsx");
    expect(f).toContain("📂 Files");
    expect(f).toContain("+12");
    expect(f).toContain("📋 Tasks");
    expect(f).toContain("message frontend-1 about T-004");
    expect(f).toContain("✦ market-terminal");
    expect(f).toContain("■ stopped");
    store.stop();
  });

  it("plain text messages the selected agent", async () => {
    const { ui, calls, store } = await setup();
    await type(ui, "use a constant for the port");
    await type(ui, "\r");
    expect(calls.find((c) => c.method === "agent.message")?.params).toMatchObject({ target: "T-004", text: "use a constant for the port" });
    expect(ui.lastFrame()).toContain("delivered to T-004");
    store.stop();
  });

  it("slash menu completes, runs commands, and shows overlays", async () => {
    const { ui, calls, store } = await setup();
    await type(ui, "/re");
    expect(ui.lastFrame()).toContain("/resume");
    expect(ui.lastFrame()).toContain("/review");
    await type(ui, "\t");
    expect(ui.lastFrame()).toContain("❯ /resume");
    await type(ui, "\u0015"); // ignore ctrl-u
    for (let i = 0; i < 10; i++) ui.stdin.write("\u007f");
    await flush();
    await type(ui, "/run\r");
    expect(calls.some((c) => c.method === "run")).toBe(true);
    expect(ui.lastFrame()).toContain("scheduler running 🚀");
    await type(ui, "/diff\r");
    await flush();
    expect(ui.lastFrame()).toContain("📜 diff T-004");
    expect(ui.lastFrame()).toContain("+added line");
    await type(ui, "\u001B");
    await type(ui, "/help\r");
    expect(ui.lastFrame()).toContain("what you can type");
    await type(ui, "\u001B");
    await type(ui, "/nope\r");
    expect(ui.lastFrame()).toContain("unknown command /nope");
    store.stop();
  });

  it("Tab switches agents; an idle agent turns text into a started task; the planner plans", async () => {
    const { ui, calls, store } = await setup();
    await type(ui, "/switch backend\r");
    expect(ui.lastFrame()).toContain("tell backend-1 what to build");
    await type(ui, "Add a health endpoint\r");
    await flush();
    expect(calls.find((c) => c.method === "task.add")?.params).toMatchObject({ title: "Add a health endpoint", role: "backend", approve: true });
    expect(calls.some((c) => c.method === "run")).toBe(true);
    expect(ui.lastFrame()).toContain("T-008 created for backend");
    await type(ui, "/switch planner\r");
    expect(ui.lastFrame()).toContain("describe what you want built");
    await type(ui, "Live quotes with a watchlist\r");
    await flush();
    expect(calls.find((c) => c.method === "plan")?.params).toMatchObject({ document: "Live quotes with a watchlist" });
    expect(ui.lastFrame()).toContain("1 draft task(s)");
    store.stop();
  });

  it("/task with @role, /approve, /theme, history; Ctrl-C quits without stopping agents; /stop stops", async () => {
    const { ui, calls, store, onExit } = await setup();
    await type(ui, "/task Write docs @backend\r");
    expect(calls.find((c) => c.method === "task.add")?.params).toMatchObject({ title: "Write docs", role: "backend" });
    await type(ui, "/approve T-7\r");
    expect(calls.find((c) => c.method === "task.approve")?.params).toEqual({ ids: ["T-007"] });
    await type(ui, "/theme matrix\r");
    expect(ui.lastFrame()).toContain("theme: matrix");
    await type(ui, "\u001B[A");
    expect(ui.lastFrame()).toContain("❯ /theme matrix");
    await type(ui, "\u0003"); // clears the input
    await type(ui, "\u0003"); // quits
    expect(onExit).toHaveBeenCalledWith({ action: "quit" });
    expect(calls.some((c) => c.method === "daemon.stop")).toBe(false);
    ui.unmount();
    const second = await setup();
    await type(second.ui, "/stop\r");
    expect(second.onExit).toHaveBeenCalledWith({ action: "stop" });
    store.stop();
    second.store.stop();
  });

  it("/attach exits to take over the current task", async () => {
    const { ui, store, onExit } = await setup();
    await type(ui, "/attach\r");
    expect(onExit).toHaveBeenCalledWith({ action: "attach", target: "T-004" });
    store.stop();
  });
});

describe("pieces", () => {
  it("parses input and completes commands", () => {
    expect(parseInput("hello")).toEqual({ kind: "message", text: "hello" });
    expect(parseInput("/rev T-4")).toEqual({ kind: "command", name: "review", args: "T-4", known: true });
    expect(parseInput("/re")).toMatchObject({ known: false });
    expect(completions("/").length).toBeGreaterThan(15);
    expect(completions("/th").map((c) => c.name)).toEqual(["theme"]);
    expect(completions("/theme x")).toEqual([]);
  });
  it("makes gradients", () => {
    const g = gradient("abc", ["#000000", "#ffffff"]);
    expect(g.map((x) => x.color)).toEqual(["#000000", "#808080", "#ffffff"]);
  });
  it("renders a stream with your messages, tools, checks and findings", () => {
    const f = render(
      <Stream
        t={THEMES.neon!}
        width={80}
        height={12}
        scroll={0}
        entries={[
          { kind: "you", text: "make it faster", ts: NOW },
          { kind: "say", text: "Profiling the render loop.", ts: NOW },
          { kind: "tool", text: "Bash", detail: "pnpm bench", ts: NOW },
          { kind: "check", text: "✗ unit", detail: "1.2s", ts: NOW },
          { kind: "finding", text: "missing null check", detail: "blocker a.ts:3", ts: NOW },
        ]}
      />,
    ).lastFrame()!;
    expect(f).toContain("❯ make it faster");
    expect(f).toContain("⏺ Profiling the render loop.");
    expect(f).toContain("⏺ Bash(pnpm bench)");
    expect(f).toContain("⎿ ✗ unit 1.2s");
    expect(f).toContain("[blocker a.ts:3] missing null check");
  });
});
