import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAdapterContract } from "../contract-suite.js";
import { fixture, parseFixture, replaySubject, standardPlans, withReplayChild } from "../testing/replay-subject.js";
import { CodexAdapter } from "./index.js";
import { createCodexParser, parseRetryIn } from "./parse.js";
import { parseRolloutRateLimits, readCodexUsage } from "./usage.js";
import type { RunRequest } from "../types.js";

class TestCodex extends CodexAdapter {
  protected override parser(req: RunRequest) {
    return withReplayChild(super.parser(req));
  }
}

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
runAdapterContract(
  replaySubject("codex (fixtures)", (o) => new TestCodex({ ...o, home: emptyHome }), standardPlans({
    success: fixture("codex/exec-success.jsonl"),
    rateLimit: fixture("codex/exec-ratelimit.jsonl"),
    limitStderr: "Error: You've hit your usage limit.\n",
    crashStdout: '{"type":"thread.started","thread_id":"t-crash"}\n',
  })),
);

describe("codex parser (recorded fixtures)", () => {
  it("parses a real successful run", () => {
    const { events, sessionIds } = parseFixture(createCodexParser(), fixture("codex/exec-success.jsonl"));
    expect(sessionIds).toEqual(["01a13b3a-a8e1-78d3-a649-45e0e9ecb79d"]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ tool: "shell", summary: expect.stringContaining("hello.txt") });
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: true, summary: "DONE" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ tokensIn: 32520 });
  });

  it("keeps the thread id on resume", () => {
    expect(parseFixture(createCodexParser(), fixture("codex/exec-resume.jsonl")).sessionIds).toEqual(["01a13b3a-a8e1-78d3-a649-45e0e9ecb79d"]);
  });

  it("maps limit errors to one rate_limit and no result", () => {
    const { events } = parseFixture(createCodexParser(() => new Date("2026-10-14T12:00:00Z")), fixture("codex/exec-ratelimit.jsonl"));
    expect(events.filter((e) => e.type === "rate_limit")).toEqual([{ type: "rate_limit", runId: "R-T-001-1", window: "unknown", resetsAt: "2026-10-14T13:24:00.000Z" }]);
    expect(events.some((e) => e.type === "result")).toBe(false);
    expect(parseRetryIn("try again in 45 minutes", new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:45:00.000Z");
  });

  it("maps a missing thread to session_expired", () => {
    expect(parseFixture(createCodexParser(), fixture("codex/exec-session-missing.stderr.txt"), "stderr").events[0]).toMatchObject({ kind: "session_expired" });
  });

  it("reads 5h and 7d windows from the session log", () => {
    const text = fs.readFileSync(fixture("codex/rollout-token-count.jsonl"), "utf8");
    expect(parseRolloutRateLimits(text, "2026-10-14T16:25:00Z")).toEqual([
      { route: "", window: "5h", usedPct: 0, resetsAt: new Date(1792013072 * 1000).toISOString(), source: "vendor", observedAt: "2026-10-14T16:25:00Z" },
      { route: "", window: "7d", usedPct: 15, resetsAt: new Date(1792473457 * 1000).toISOString(), source: "vendor", observedAt: "2026-10-14T16:25:00Z" },
    ]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const day = path.join(home, "sessions/2026/10/14");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-2026-10-14T20-24-23-thread-1.jsonl"), text);
    expect(readCodexUsage("thread-1", home)).toHaveLength(2);
    expect(readCodexUsage("other", home)).toEqual([]);
    expect(readCodexUsage(undefined, home)).toHaveLength(2);
    expect(readCodexUsage(undefined, emptyHome)).toEqual([]);
  });

  it("builds argv for exec and resume", () => {
    const a = new CodexAdapter() as unknown as { args(r: Partial<RunRequest>): string[] };
    expect(a.args({ prompt: "p", mode: "write", runId: "R" })).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "p"]);
    expect(a.args({ prompt: "p", mode: "readonly", resumeSessionId: "t1", runId: "R" })).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "t1", "p"]);
    expect(new CodexAdapter().interactiveCommand("t1", "/x").argv.slice(-2)).toEqual(["resume", "t1"]);
  });
});
