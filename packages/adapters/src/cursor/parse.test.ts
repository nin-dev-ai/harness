import { describe, expect, it } from "vitest";
import { runAdapterContract } from "../contract-suite.js";
import { fixture, parseFixture, replaySubject, standardPlans, withReplayChild } from "../testing/replay-subject.js";
import { CursorAdapter } from "./index.js";
import { createCursorParser } from "./parse.js";
import type { RunRequest } from "../types.js";

class TestCursor extends CursorAdapter {
  protected override parser(req: RunRequest) {
    return withReplayChild(super.parser(req));
  }
}

runAdapterContract(
  replaySubject("cursor (fixtures)", (o) => new TestCursor(o), standardPlans({
    success: fixture("cursor/stream-success.jsonl"),
    limitStderr: "Error: usage limit reached for this billing period\n",
    crashStdout: '{"type":"system","subtype":"init","session_id":"s-crash"}\n',
  })),
);

describe("cursor parser (recorded fixtures)", () => {
  it("parses a real successful write run", () => {
    const { events, sessionIds } = parseFixture(createCursorParser(), fixture("cursor/stream-success.jsonl"));
    expect(new Set(sessionIds)).toEqual(new Set(["9d3fe322-9fe9-4450-b7e9-1246f2b337e3"]));
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ tool: "edit" });
    expect(events.find((e) => e.type === "file_change")).toMatchObject({ path: expect.stringMatching(/hello\.txt$/) });
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: true, summary: "DONE" });
    expect(events.some((e) => e.type === "message" && e.text.includes("thinking"))).toBe(false);
  });

  it("keeps the session id on resume", () => {
    const { events, sessionIds } = parseFixture(createCursorParser(), fixture("cursor/stream-resume.jsonl"));
    expect(new Set(sessionIds)).toEqual(new Set(["9d3fe322-9fe9-4450-b7e9-1246f2b337e3"]));
    expect(events.find((e) => e.type === "result")).toMatchObject({ summary: "OK" });
  });

  it("builds argv for write and readonly", async () => {
    const a = new CursorAdapter() as unknown as { args(r: Partial<RunRequest>): string[] };
    expect(a.args({ prompt: "p", mode: "write" })).toEqual(["-p", "p", "--output-format", "stream-json", "--trust", "--force"]);
    expect(a.args({ prompt: "p", mode: "readonly", resumeSessionId: "c1" })).toEqual(["-p", "p", "--output-format", "stream-json", "--trust", "--mode", "plan", "--resume", "c1"]);
    expect(await new CursorAdapter().usage("cursor-key")).toEqual([]);
  });
});
