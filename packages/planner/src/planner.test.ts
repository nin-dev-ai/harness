import { describe, expect, it } from "vitest";
import { buildRepairPrompt, buildReviewPrompt, buildReviewRepairPrompt, buildTaskPrompt, buildFreshResumePrompt, buildResumePrompt } from "./build.js";
import { parseReview } from "./review.js";
import { extractJson } from "./validate.js";

describe("prompt assembly", () => {
  const base = {
    role: "frontend", instructions: "React and TypeScript.", taskId: "T-004", title: "Watchlist panel", body: "Show symbols.",
    acceptance: ["Panel lists symbols"], agentsMd: true, pathsAllow: ["src/ui/**"], pathsDeny: [".github/**"],
    checks: [{ id: "unit", argv: ["pnpm", "test"], required: true }],
  };

  it("builds the task prompt deterministically with the independence sentence", () => {
    const p = buildTaskPrompt(base);
    expect(p).toBe(buildTaskPrompt(base));
    expect(p).toContain("The harness will run these independently. Your claim that they pass is not used.");
    expect(p).toContain("`pnpm test`");
    expect(p).toContain("- Panel lists symbols");
    expect(p).toContain("Read AGENTS.md");
    expect(p).not.toMatch(/\{\{/);
    expect(buildTaskPrompt({ ...base, contractRef: "docs/contracts/q.ts" })).toContain("docs/contracts/q.ts");
  });

  it("builds repair prompts from check output and diff only", () => {
    const p = buildRepairPrompt({ attempt: 2, attemptsMax: 3, failures: [{ checkId: "unit", argv: ["pnpm", "test"], outputTail: "1 failed" }], diffStat: " a.ts | 2 +-" });
    expect(p).toContain("attempt 2 of 3");
    expect(p).toContain("1 failed");
    expect(p).toContain("Do not weaken, skip or delete tests");
    const r = buildReviewRepairPrompt({ taskId: "T-1", attempt: 2, attemptsMax: 3, findings: [{ severity: "blocker", file: "a.ts", line: 3, message: "bug" }, { severity: "nit", file: null, line: null, message: "name" }] });
    expect(r).toMatch(/Blocking findings\n- `a.ts:3`: bug/);
    expect(r).toContain("[nit] name");
    expect(buildResumePrompt("T-1")).toMatch(/^Continue from your last checkpoint/);
    expect(buildFreshResumePrompt("TASK", "x | 1 +")).toContain("Continue from there");
  });

  it("builds the review prompt", () => {
    const p = buildReviewPrompt({ taskId: "T-1", title: "t", acceptance: [], checks: ["unit"], diff: "+a" });
    expect(p).toContain("do not edit any file");
    expect(p).toContain('"severity": "blocker"');
  });
});

describe("review output", () => {
  it("accepts structured output and JSON in text", () => {
    expect(parseReview({ summary: "s", findings: [] }, "")).toEqual({ ok: true, review: { summary: "s", findings: [] } });
    const r = parseReview(undefined, 'Here you go:\n```json\n{"summary":"x","findings":[{"severity":"blocker","file":"a.ts","line":1,"message":"m"}]}\n```');
    expect(r.ok && r.review.findings[0]?.severity).toBe("blocker");
    const r2 = parseReview(undefined, '{"findings":[{"severity":"nit","message":"m"}]}');
    expect(r2.ok && r2.review.findings[0]).toEqual({ severity: "nit", file: null, line: null, message: "m" });
  });
  it("rejects invalid output", () => {
    expect(parseReview(undefined, "looks good to me").ok).toBe(false);
    expect(parseReview({ findings: [{ severity: "critical", message: "x" }] }, "").ok).toBe(false);
    expect(extractJson("no json")).toBeUndefined();
  });
});
