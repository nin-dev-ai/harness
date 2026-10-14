import { describe, expect, it } from "vitest";
import { runAdapterContract } from "../contract-suite.js";
import { fixture, parseFixture, replaySubject, standardPlans, withReplayChild } from "../testing/replay-subject.js";
import { ClaudeAdapter } from "./index.js";
import { createClaudeParser } from "./parse.js";
import type { UsageSnapshot } from "@harness/core";
import type { RunRequest } from "../types.js";

class TestClaude extends ClaudeAdapter {
  protected override parser(req: RunRequest) {
    return withReplayChild(super.parser(req));
  }
}

runAdapterContract(
  replaySubject("claude (fixtures)", (o) => new TestClaude(o), standardPlans({
    success: fixture("claude/stream-success.jsonl"),
    rateLimit: fixture("claude/stream-ratelimit.jsonl"),
    limitStderr: "Claude usage limit reached. Your limit will reset at 2pm\n",
    crashStdout: '{"type":"system","subtype":"init","session_id":"s-crash"}\n',
  })),
);

describe("claude parser (recorded fixtures)", () => {
  it("parses a real successful write run", () => {
    const windows: UsageSnapshot[][] = [];
    const { events, sessionIds } = parseFixture(createClaudeParser((w) => windows.push(w), () => new Date("2026-10-14T16:20:00Z")), fixture("claude/stream-success.jsonl"));
    expect(new Set(sessionIds)).toEqual(new Set(["c8cd2771-4019-496e-8061-d7763ea11392"]));
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ tool: "Write" });
    expect(events.find((e) => e.type === "file_change")).toMatchObject({ path: expect.stringMatching(/hello\.txt$/) });
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: true, summary: "DONE" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ costUsd: expect.any(Number) });
    expect(events.some((e) => e.type === "rate_limit")).toBe(false);
    expect(windows.at(-1)).toEqual([
      { route: "", window: "5h", usedPct: 16, resetsAt: "2026-10-14T21:00:00.000Z", source: "vendor", observedAt: "2026-10-14T16:20:00.000Z" },
      { route: "", window: "7d", usedPct: 27, resetsAt: "2026-10-20T01:00:00.000Z", source: "vendor", observedAt: "2026-10-14T16:20:00.000Z" },
    ]);
  });

  it("keeps the session id on resume", () => {
    const { events, sessionIds } = parseFixture(createClaudeParser(), fixture("claude/stream-resume.jsonl"));
    expect(new Set(sessionIds)).toEqual(new Set(["c8cd2771-4019-496e-8061-d7763ea11392"]));
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: true, summary: "OK" });
  });

  it("maps a rejected rate_limit_event to one rate_limit with the reset time", () => {
    const { events } = parseFixture(createClaudeParser(), fixture("claude/stream-ratelimit.jsonl"));
    expect(events.filter((e) => e.type === "rate_limit")).toEqual([{ type: "rate_limit", runId: "R-T-001-1", window: "5h", resetsAt: "2026-10-14T21:00:00.000Z" }]);
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: false });
  });

  it("maps a missing session to session_expired", () => {
    const { events } = parseFixture(createClaudeParser(), fixture("claude/stream-session-missing.stderr.txt"), "stderr");
    expect(events[0]).toMatchObject({ type: "error", kind: "session_expired" });
    expect(parseFixture(createClaudeParser(), fixture("claude/stream-session-missing.jsonl")).events.find((e) => e.type === "result")).toMatchObject({ ok: false });
  });

  it("builds argv for write, readonly, resume and schema runs", async () => {
    const a = new ClaudeAdapter() as unknown as { args(r: Partial<RunRequest>): string[] };
    const w = a.args({ prompt: "p", mode: "write" });
    expect(w.slice(0, 5)).toEqual(["-p", "p", "--output-format", "stream-json", "--verbose"]);
    expect(w).toContain("acceptEdits");
    const r = a.args({ prompt: "p", mode: "readonly", resumeSessionId: "s1", model: "m", jsonSchema: { type: "object" } });
    expect(r).toEqual(expect.arrayContaining(["plan", "--resume", "s1", "--model", "m", "--json-schema"]));
    expect(new ClaudeAdapter().interactiveCommand("s1", "/x").argv.slice(-2)).toEqual(["--resume", "s1"]);
  });
});
