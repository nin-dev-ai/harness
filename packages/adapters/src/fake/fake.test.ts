import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collect, runAdapterContract, type ContractScenario } from "../contract-suite.js";
import { filterEnv } from "../process.js";
import { FakeAdapter, type FakeScript } from "./index.js";
import type { RunRequest } from "../types.js";

const scripts: Record<ContractScenario, FakeScript> = {
  success: { steps: [{ kind: "message", text: "working" }, { kind: "tool_call", tool: "bash", summary: "pnpm test" }, { kind: "result", ok: true, summary: "done" }] },
  rate_limit: { steps: [{ kind: "message", text: "a" }, { kind: "rate_limit", window: "5h", resetsAt: "2026-01-05T14:05:00Z" }] },
  unstructured_limit: { steps: [{ kind: "rate_limit", structured: false }] },
  garbage: { steps: [{ kind: "raw", line: "not json at all" }, { kind: "raw", line: '{"t":"brand-new-event"}' }, { kind: "raw", line: "{broken" }, { kind: "result", ok: true }] },
  crash: { steps: [{ kind: "message", text: "about to crash" }, { kind: "crash", code: 3 }] },
  hang: { steps: [{ kind: "hang" }] },
  hang_with_child: { steps: [{ kind: "spawn_child" }, { kind: "hang" }] },
};

runAdapterContract({ name: "fake", prepare: (s) => new FakeAdapter({ script: scripts[s] }) });

describe("fake adapter", () => {
  const base = (cwd: string, over: Partial<RunRequest> = {}): RunRequest => ({
    runId: "R-T-001-1", cwd, prompt: "p", mode: "write", allowedPaths: ["**"], env: filterEnv(process.env), timeoutMs: 10_000, ...over,
  });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "harness-fake-"));

  it("writes files for file_change steps and reports them", async () => {
    const cwd = tmp();
    const a = new FakeAdapter({ script: { steps: [{ kind: "file_change", path: "src/a.ts", content: "export const a = 1;\n" }, { kind: "result", ok: true }] } });
    const events = await collect(a.run(base(cwd)));
    expect(events.some((e) => e.type === "file_change" && e.path === "src/a.ts")).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "src/a.ts"), "utf8")).toContain("a = 1");
    fs.rmSync(cwd, { recursive: true });
  });

  it("reports the session id and keeps it on resume", async () => {
    const cwd = tmp();
    const a = new FakeAdapter({ script: { sessionId: "sess-1", steps: [{ kind: "result", ok: true }], resumeSteps: [{ kind: "message", text: "resumed" }, { kind: "result", ok: true }] } });
    const first = await collect(a.run(base(cwd)));
    expect(first[0]).toMatchObject({ type: "started", sessionId: "sess-1" });
    const second = await collect(a.run(base(cwd, { runId: "R-T-001-2", resumeSessionId: "sess-1" })));
    expect(second[0]).toMatchObject({ type: "started", sessionId: "sess-1" });
    expect(second.some((e) => e.type === "message" && e.text === "resumed")).toBe(true);
    fs.rmSync(cwd, { recursive: true });
  });

  it("can simulate an expired session on resume", async () => {
    const cwd = tmp();
    const a = new FakeAdapter({ script: { steps: [], sessionExpiredOnResume: true } });
    const events = await collect(a.run(base(cwd, { resumeSessionId: "old" })));
    expect(events.some((e) => e.type === "error" && e.kind === "session_expired")).toBe(true);
    fs.rmSync(cwd, { recursive: true });
  });

  it("carries the rate-limit reset time", async () => {
    const cwd = tmp();
    const a = new FakeAdapter({ script: scripts.rate_limit });
    const events = await collect(a.run(base(cwd)));
    expect(events.find((e) => e.type === "rate_limit")).toMatchObject({ window: "5h", resetsAt: "2026-01-05T14:05:00Z" });
    fs.rmSync(cwd, { recursive: true });
  });

  it("scripts per request and exposes controllable usage", async () => {
    const a = new FakeAdapter({ script: (req) => ({ steps: [{ kind: "result", ok: true, summary: req.runId }] }) });
    const cwd = tmp();
    const events = await collect(a.run(base(cwd, { runId: "R-T-007-1" })));
    expect(events.find((e) => e.type === "result")).toMatchObject({ summary: "R-T-007-1" });
    expect(await a.usage("x")).toEqual([]);
    a.setUsage("x", [{ route: "x", window: "5h", usedPct: 40, resetsAt: null, source: "vendor", observedAt: "t" }]);
    expect(await a.usage("x")).toHaveLength(1);
    expect(a.interactiveCommand("s", cwd).argv).toContain("--interactive");
    fs.rmSync(cwd, { recursive: true });
  });
});
