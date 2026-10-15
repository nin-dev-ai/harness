import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { App } from "./App.js";
import { completions, parseInput } from "./commands.js";
import { gradient } from "./theme.js";
import { TuiStore, type TuiApi } from "./store.js";
import { suggestScope, Wizard, type WizardResult } from "./Wizard.js";

const NOW = "2026-01-05T12:41:00.000Z";
const task = (id: string, title: string, role: string, state: "RUNNING" | "DRAFT" | "QUEUED" | "NEEDS_HUMAN", extra: Record<string, unknown> = {}) => ({
  id, projectId: "p", title, role, state, size: "M" as const, dependsOn: [] as string[], attempts: 1, attemptsMax: 3, branch: null, worktree: null, specPath: "", blockedReason: null, createdAt: NOW, updatedAt: NOW, lastRunId: null, ...extra,
});
const worker = (id: string, role: string, vendor: string, route: string, state: "RUNNING" | "IDLE", taskId: string | null = null) => ({
  id, projectId: "p", role, state, currentRun: taskId ? `R-${taskId}-1` : null, heartbeatAt: null, waitingReason: null, vendor, route, taskId, taskTitle: null, runKind: taskId ? "initial" : null, elapsedMs: taskId ? 12 * 60_000 : null,
});

const BASE = (): StatusSnapshot => ({
  project: { id: "p", name: "market-terminal", root: "/repo", integrationBranch: "harness/integration", autonomy: "approved-scope" },
  scheduler: { running: true, until: null, burst: true },
  now: NOW,
  workers: [worker("frontend-1", "frontend", "codex", "codex", "RUNNING", "T-004"), worker("backend-1", "backend", "claude", "claude-opus", "RUNNING", "T-005"), worker("fullstack-1", "fullstack", "cursor", "cursor", "IDLE"), worker("reviewer-1", "reviewer", "claude", "claude-opus", "IDLE"), worker("planner-1", "planner", "claude", "claude-opus", "IDLE")],
  tasks: [task("T-004", "Watchlist panel", "frontend", "RUNNING", { lastRunId: "R-T-004-1" }), task("T-005", "Quote feed", "backend", "RUNNING", { lastRunId: "R-T-005-1" })],
  routes: [
    { route: "claude-opus", vendor: "claude", auth: "subscription", model: "opus", pausedUntil: null, pauseSource: null, windows: [{ route: "claude-opus", vendor: "claude", kind: "5h", usedPct: 62, display: "62%", resetsAt: "2026-01-05T14:05:00.000Z", source: "vendor", observedAt: NOW, stale: false, capPct: 100 }] },
    { route: "codex", vendor: "codex", auth: "subscription", model: null, pausedUntil: null, pauseSource: null, windows: [] },
    { route: "cursor", vendor: "cursor", auth: "subscription", model: null, pausedUntil: null, pauseSource: null, windows: [] },
  ],
  approvals: [],
  warnings: [],
});

function fakeApi(snapshot: () => StatusSnapshot = BASE) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(e: HarnessEvent) => void>();
  const api: TuiApi = {
    call: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "status") return snapshot() as T;
      if (method === "events.list") return [] as T;
      if (method === "task.show") return { spec: { body: "Show a watchlist with FRESH / STALE states", front: { acceptance: ["lists symbols"] } }, runs: [{ id: "R-T-004-1", kind: "initial", state: "RUNNING", route: "codex", checks: [{ checkId: "unit", ok: false }] }] } as T;
      if (method === "review.show") return { task: { id: "T-004", title: "Watchlist panel", state: "RUNNING" }, stat: "", diff: "+added line\n-removed line", checks: [{ checkId: "unit", ok: false, required: true }], gate: "gate.failed", findings: [], fileStats: [{ path: "src/ui/Watchlist.tsx", insertions: 30, deletions: 4 }] } as T;
      if (method === "dispatch") return { summary: "Quote feed first, then the panel.", tasks: [{ id: "T-008", title: "Quote feed", role: "backend", dependsOn: [] }, { id: "T-009", title: "Watchlist", role: "frontend", dependsOn: ["T-008"] }] } as T;
      if (method === "agent.message") return { taskId: "T-004", delivery: "now" } as T;
      if (method === "task.add") return { id: "T-010" } as T;
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
async function setup(snapshot?: () => StatusSnapshot, columns = 150) {
  const f = fakeApi(snapshot);
  const store = new TuiStore(f.api);
  await store.start();
  const onExit = vi.fn();
  const onTheme = vi.fn();
  const ui = render(<App store={store} onExit={onExit} onTheme={onTheme} size={{ columns, rows: 36 }} />);
  await flush(500);
  return { ...f, store, ui, onExit, onTheme };
}
const send = async (ui: ReturnType<typeof render>, text: string) => {
  ui.stdin.write(text);
  await flush();
  ui.stdin.write("\r");
  await flush(80);
};
const ev = (type: string, taskId: string, workerId: string, payload: unknown): HarnessEvent => ({ ts: NOW, projectId: "p", type, taskId, workerId, runId: `R-${taskId}-1`, payload }) as unknown as HarnessEvent;

describe("chat with your team", () => {
  it("opens one live pane per agent, in each tool's own session, with usage on top", async () => {
    const { ui, emit, store } = await setup();
    emit(ev("run.event", "T-004", "frontend-1", { event: { type: "tool_call", runId: "R-T-004-1", tool: "Bash", summary: "npm test" } }));
    emit(ev("run.event", "T-005", "backend-1", { event: { type: "message", runId: "R-T-005-1", text: "Writing the quote feed adapter" } }));
    emit(ev("run.event", "T-005", "backend-1", { event: { type: "file_change", runId: "R-T-005-1", path: "src/server/feed.ts" } }));
    await flush(300);
    const f = ui.lastFrame()!;
    expect(f).toContain("✦ harness");
    expect(f).toContain("frontend-1");
    expect(f).toContain("backend-1");
    expect(f).toContain("fullstack-1");
    expect(f).toContain("reviewer-1");
    expect(f).toContain("planner-1");
    expect(f).toContain("codex/default");
    expect(f).toContain("claude/opus");
    expect(f).toContain("cursor/default");
    expect(f).toContain("T-004 Watchlist panel");
    expect(f).toContain("T-005 Quote feed");
    expect(f).toContain("⏺ Bash(npm test)");
    expect(f).toContain("⏺ Writing the quote feed adapter");
    expect(f).toContain("✎ src/server/feed.ts");
    expect(f).toContain("5h");
    expect(f).toContain("62%");
    expect(f).toContain("usage unknown");
    expect(f).toContain("❯ team");
    expect(f).toContain("tell your 5 agents what to build");
    expect(f).toContain("▶ running");
    store.stop();
  });

  it("a plain message goes to the planner, which splits it across agents and starts them", async () => {
    const { ui, calls, store } = await setup();
    await send(ui, "build a watchlist with live quotes");
    expect(calls.find((c) => c.method === "dispatch")?.params).toMatchObject({ document: "build a watchlist with live quotes", source: "chat" });
    const f = ui.lastFrame()!;
    expect(f).toContain("❯ build a watchlist with live quotes");
    expect(f).toContain("→ backend: Quote feed");
    expect(f).toContain("→ frontend: Watchlist (after T-008)");
    expect(f).toContain("2 tasks started");
    store.stop();
  });

  it("Tab selects an agent; messages then go straight to it, and Tab back returns to the team", async () => {
    const { ui, calls, store } = await setup();
    ui.stdin.write("\t");
    await flush();
    expect(ui.lastFrame()).toContain("❯ backend-1");
    await send(ui, "use a constant for the port");
    expect(calls.find((c) => c.method === "agent.message")?.params).toMatchObject({ target: "T-005", text: "use a constant for the port" });
    expect(calls.some((c) => c.method === "dispatch")).toBe(false);
    expect(ui.lastFrame()).toContain("❯ use a constant for the port");
    for (let i = 0; i < 5; i++) {
      ui.stdin.write("\t");
      await flush();
    }
    expect(ui.lastFrame()).toContain("❯ team");
    store.stop();
  });

  it("an idle agent turns a direct message into a new started task", async () => {
    const { ui, calls, store } = await setup();
    await send(ui, "/switch fullstack");
    expect(ui.lastFrame()).toContain("❯ fullstack-1");
    await send(ui, "add a login page");
    expect(calls.find((c) => c.method === "task.add")?.params).toMatchObject({ title: "add a login page", role: "fullstack", approve: true });
    expect(calls.some((c) => c.method === "run")).toBe(true);
    expect(ui.lastFrame()).toContain("T-010 started");
    store.stop();
  });

  it("slash commands: menu, /agents, /usage, /zoom, /theme", async () => {
    const { ui, calls, store, onTheme } = await setup();
    ui.stdin.write("/");
    await flush();
    expect(ui.lastFrame()).toContain("/agents");
    expect(ui.lastFrame()).toContain("/switch");
    ui.stdin.write("age");
    await flush();
    ui.stdin.write("\r");
    await flush(80);
    let f = ui.lastFrame()!;
    expect(f).toContain("who is doing what");
    expect(f).toMatch(/AGENT\s+TOOL\s+STATUS\s+TASK/);
    expect(f).toMatch(/frontend-1\s+codex\/default\s+working\s+T-004 Watchlist panel/);
    ui.stdin.write("\u001B");
    await flush();
    await send(ui, "/usage");
    f = ui.lastFrame()!;
    expect(f).toContain("unknown is never shown as 0%");
    expect(f).toContain("claude-opus");
    ui.stdin.write("\u001B");
    await flush();
    await send(ui, "/zoom");
    expect(ui.lastFrame()).toContain("Tab to an agent first");
    ui.stdin.write("\t");
    await flush();
    await send(ui, "/zoom");
    f = ui.lastFrame()!;
    expect(f).toContain("brief");
    expect(f).toContain("Show a watchlist with FRESH / STALE states");
    expect(f).toContain("checks");
    expect(f).not.toContain("fullstack-1");
    ui.stdin.write("\u001B");
    await flush();
    expect(ui.lastFrame()).toContain("fullstack-1");
    await send(ui, "/theme sunset");
    expect(onTheme).toHaveBeenCalledWith("sunset");
    await send(ui, "/nope");
    expect(ui.lastFrame()).toContain("unknown command /nope");
    expect(calls.some((c) => c.method === "dispatch")).toBe(false);
    store.stop();
  });

  it("/review and /diff show the selected agent's evidence; /accept, /pause, /task call the daemon", async () => {
    const { ui, calls, store } = await setup();
    ui.stdin.write("\t");
    await flush();
    await send(ui, "/review");
    expect(ui.lastFrame()).toContain("review T-004");  // the fake returns T-004's evidence
    expect(ui.lastFrame()).toContain("✗ unit");
    ui.stdin.write("\u001B");
    await flush();
    await send(ui, "/diff");
    expect(ui.lastFrame()).toContain("+added line");
    ui.stdin.write("\u001B");
    await flush();
    await send(ui, "/pause");
    expect(calls.find((c) => c.method === "pause")?.params).toEqual({ task: "T-005" });
    await send(ui, "/task Add health check @backend");
    expect(calls.find((c) => c.method === "task.add")?.params).toMatchObject({ title: "Add health check", role: "backend", approve: true });
    await send(ui, "/approve all");
    expect(calls.find((c) => c.method === "task.approve")?.params).toEqual({ all: true });
    store.stop();
  });

  it("Ctrl-C closes without stopping agents; /stop stops; /setup asks for the wizard; /attach hands over the task", async () => {
    const a = await setup();
    a.ui.stdin.write("\u0003");
    await flush();
    expect(a.onExit).toHaveBeenCalledWith({ action: "quit" });
    expect(a.calls.some((c) => c.method === "daemon.stop")).toBe(false);
    a.store.stop();
    const b = await setup();
    await send(b.ui, "/stop");
    expect(b.onExit).toHaveBeenCalledWith({ action: "stop" });
    b.store.stop();
    const c = await setup();
    await send(c.ui, "/setup");
    expect(c.onExit).toHaveBeenCalledWith({ action: "setup" });
    c.store.stop();
    const d = await setup();
    d.ui.stdin.write("\t");
    await flush();
    await send(d.ui, "/attach");
    expect(d.onExit).toHaveBeenCalledWith({ action: "attach", target: "T-005" });
    d.store.stop();
  });

  it("a fresh project shows the banner and an invitation", async () => {
    const { ui, store } = await setup(() => ({ ...BASE(), tasks: [], workers: BASE().workers.map((w) => ({ ...w, state: "IDLE" as const, taskId: null, currentRun: null, elapsedMs: null })) }));
    const f = ui.lastFrame()!;
    expect(f).toContain("┣━┫┣━┫┣┳┛");
    expect(f).toContain("Describe what you want");
    store.stop();
  });

  it("narrow terminals stack panes in one column", async () => {
    const { ui, store } = await setup(undefined, 60);
    const f = ui.lastFrame()!;
    expect(f).toContain("frontend-1");
    expect(f).toContain("backend-1");
    store.stop();
  });
});

describe("setup wizard", () => {
  it("offers frontend, backend, full stack and more; walks tools and per-agent choices", async () => {
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
    const roles = ui.lastFrame()!;
    expect(roles).toContain("[x] backend");
    expect(roles).toContain("[x] frontend");
    expect(roles).toContain("[ ] fullstack");
    // backend, frontend, fullstack: turn fullstack on
    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write(" ");
    await flush();
    expect(ui.lastFrame()).toContain("[x] fullstack");
    ui.stdin.write("\r");
    await flush();
    expect(ui.lastFrame()).toContain("agent 1 of 5: backend");
    expect(ui.lastFrame()).toContain("src/server/**");
    for (let i = 0; i < 5; i++) {
      ui.stdin.write("\r");
      await flush();
    }
    expect(ui.lastFrame()).toContain("ready");
    ui.stdin.write("\r");
    await flush();
    const r = result as unknown as WizardResult[];
    expect(r.map((a) => [a.role, a.vendor, a.mode])).toEqual([
      ["backend", "claude", "write"],
      ["frontend", "codex", "write"],
      ["fullstack", "claude", "write"],
      ["reviewer", "codex", "readonly"],
      ["planner", "claude", "readonly"],
    ]);
    expect(r[2]).toMatchObject({ pathsAllow: ["src/**"] });
  });

  it("suggests write scopes from the repo's folders", () => {
    expect(suggestScope("frontend", ["src", "web"])).toBe("web/**");
    expect(suggestScope("backend", ["api", "src"])).toBe("api/**");
    expect(suggestScope("fullstack", ["src"])).toBe("src/**");
    expect(suggestScope("docs", [])).toBe("docs/**, **/*.md");
  });
});

describe("pieces", () => {
  it("parses input and completes commands", () => {
    expect(parseInput("hello")).toEqual({ kind: "message", text: "hello" });
    expect(parseInput("/rev T-4")).toEqual({ kind: "command", name: "review", args: "T-4", known: true });
    expect(parseInput("/re")).toMatchObject({ known: false });
    expect(completions("/").length).toBeGreaterThan(15);
    expect(completions("/th").map((c) => c.name)).toEqual(["theme"]);
    expect(completions("hello")).toEqual([]);
  });
  it("makes gradients", () => {
    expect(gradient("abc", ["#000000", "#ffffff"]).map((x) => x.color)).toEqual(["#000000", "#808080", "#ffffff"]);
  });
});
