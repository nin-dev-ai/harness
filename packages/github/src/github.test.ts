import { describe, expect, it } from "vitest";
import { buildPrBody, findPr, openDraftPr, type Evidence } from "./pr.js";
import { gh, type Runner } from "./gh.js";
import { issueMarker, issueTaskBody, labeledIssues } from "./issues.js";

const evidence: Evidence = {
  project: "market-terminal",
  base: "main",
  head: "harness/integration",
  tasks: [
    { id: "T-001", title: "Quote contract", role: "backend", route: "claude-sub", attempts: 1, checks: [{ checkId: "unit", ok: true, durationMs: 1200, required: true }, { checkId: "build", ok: true, durationMs: null, required: false }], findings: [], runs: 2, tokensIn: 1000, tokensOut: 200, costUsd: 0.12 },
    { id: "T-002", title: "Panel | v2", role: "frontend", route: "codex-sub", attempts: 2, checks: [{ checkId: "unit", ok: true, durationMs: 900, required: true }], findings: [{ severity: "blocker", file: "a.ts", line: 3, message: "null check" }, { severity: "nit", file: null, line: null, message: "rename" }], runs: 4, tokensIn: null, tokensOut: null, costUsd: null },
  ],
};

function fakeRunner(responses: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (args.includes("merge")) throw new Error("merge must never be called");
    const key = [cmd, ...args.slice(0, 2)].join(" ");
    return { stdout: responses[key] ?? "", stderr: "", exitCode: 0, ...(opts.input ? {} : {}) };
  };
  return { run, calls };
}

describe("github", () => {
  it("builds the PR body with tasks, checks, findings and usage", () => {
    const body = buildPrBody(evidence);
    expect(body).toMatchSnapshot();
    expect(body).toContain("| T-002 | Panel \\| v2 |");
    expect(body).toContain("✅ unit (1.2s), ✅ build (optional)");
    expect(body).toContain("**T-002** [blocker] `a.ts:3` null check");
    expect(body).toContain("| T-002 | 4 | unknown | unknown |");
    expect(body).toContain("merging is your decision");
  });

  it("pushes the harness branch and opens a draft PR, reusing an existing one", async () => {
    const { run, calls } = fakeRunner({ "gh pr create": "https://github.com/o/r/pull/7", "gh pr list": "[]" });
    const r = await openDraftPr({ cwd: "/x", base: "main", head: "harness/integration", title: "t", body: "b", run });
    expect(r).toEqual({ url: "https://github.com/o/r/pull/7", existed: false });
    expect(calls[0]).toEqual(["git", "push", "-u", "origin", "harness/integration:harness/integration"]);
    expect(calls.at(-1)).toEqual(["gh", "pr", "create", "--draft", "--base", "main", "--head", "harness/integration", "--title", "t", "--body-file", "-"]);
    const again = fakeRunner({ "gh pr list": JSON.stringify([{ url: "https://github.com/o/r/pull/7", number: 7 }]) });
    expect(await openDraftPr({ cwd: "/x", base: "main", head: "harness/integration", title: "t", body: "b", run: again.run })).toEqual({ url: "https://github.com/o/r/pull/7", existed: true });
    expect(again.calls.some((c) => c.includes("create"))).toBe(false);
    expect(await findPr(again.run, "/x", "harness/integration")).toMatchObject({ number: 7 });
  });

  it("never pushes non-harness branches and never merges", async () => {
    const { run } = fakeRunner();
    await expect(openDraftPr({ cwd: "/x", base: "main", head: "main", title: "t", body: "b", run })).rejects.toThrow(/refusing to push main/);
    await expect(gh(run, "/x", ["pr", "merge", "7"])).rejects.toThrow(/refusing/);
  });

  it("lists labeled issues and marks task bodies", async () => {
    const { run } = fakeRunner({ "gh issue list": JSON.stringify([{ number: 3, title: "Bug", body: "it breaks", url: "https://github.com/o/r/issues/3" }]) });
    const issues = await labeledIssues(run, "/x", "harness");
    expect(issues[0]?.title).toBe("Bug");
    expect(issueTaskBody(issues[0]!)).toContain(issueMarker(issues[0]!));
  });
});
