import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChecksConfigSchema, type ChecksConfig } from "@harness/core";
import { failureSignature, normalizeLine } from "./signature.js";
import { checkEnv, gateOutcome, runChecks, runSetup } from "./runner.js";
import { assessReadiness } from "./readiness.js";
import { formatCheckResults, formatReadiness } from "./report.js";

const node = process.execPath;
const cfg = (checks: unknown[], extra: Record<string, unknown> = {}): ChecksConfig => ChecksConfigSchema.parse({ version: 1, checks, ...extra });

describe("failure signatures", () => {
  const out = (p: string, line: number) => `
 FAIL  ${p}/src/panels/stale-state.test.ts > Watchlist > marks STALE after 30s
AssertionError: expected 'FRESH' to be 'STALE'
 ❯ ${p}/src/panels/stale-state.test.ts:${line}:17
 Tests  3 passed, 1 failed (412ms)
 Duration  1.${line}s`;

  it("is stable across paths, line numbers and timings", () => {
    const a = failureSignature("unit", out("/Users/a/repo/.harness/worktrees/T-004", 42));
    const b = failureSignature("unit", out("/tmp/other/T-009", 57));
    expect(a).toBe(b);
  });

  it("keeps test names and differs per check or failure", () => {
    const a = failureSignature("unit", out("/x", 1));
    expect(failureSignature("lint", out("/x", 1))).not.toBe(a);
    expect(failureSignature("unit", out("/x", 1).replace("marks STALE", "marks DELAYED"))).not.toBe(a);
  });

  it("normalizes compiler-style locations", () => {
    expect(normalizeLine("src/a.ts(12,5): error TS2322: Type 'x'")).toBe("a.ts: error TS2322: Type 'x'");
    expect(normalizeLine("\u001b[31mError\u001b[0m at /abs/path/file.py line 33")).toBe("Error at file.py line");
  });
});

describe("check runner", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-verify-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("runs argv checks and records results", async () => {
    const results = await runChecks(dir, cfg([
      { id: "pass", argv: [node, "-e", "console.log('ok')"] },
      { id: "fail", argv: [node, "-e", "console.error('Error: boom'); process.exit(2)"] },
      { id: "opt", argv: [node, "-e", "process.exit(1)"], required: false },
    ]));
    expect(results.map((r) => [r.checkId, r.ok, r.exitCode])).toEqual([["pass", true, 0], ["fail", false, 2], ["opt", false, 1]]);
    expect(results[1]?.outputTail).toContain("Error: boom");
    expect(results[1]?.signature).toMatch(/^[0-9a-f]{16}$/);
    const gate = gateOutcome(results);
    expect(gate.passed).toBe(false);
    expect(gate.failedRequired.map((r) => r.checkId)).toEqual(["fail"]);
    expect(formatCheckResults(results)).toContain("✗ fail");
  });

  it("uses no shell", async () => {
    const [r] = await runChecks(dir, cfg([{ id: "x", argv: ["echo", "$HOME && rm -rf /"] }]));
    expect(r?.outputTail.trim()).toBe("$HOME && rm -rf /");
  });

  it("times out and kills the process group", async () => {
    const [r] = await runChecks(dir, cfg([{ id: "slow", argv: [node, "-e", "setInterval(()=>{},1000)"], timeout_s: 0.3 }]));
    expect(r).toMatchObject({ ok: false, timedOut: true });
  });

  it("reports a command that cannot start as a failure", async () => {
    const [r] = await runChecks(dir, cfg([{ id: "missing", argv: ["no-such-binary-xyz"] }]));
    expect(r?.ok).toBe(false);
    expect(r?.startError).toBeTruthy();
    expect(gateOutcome([r!]).passed).toBe(false);
  });

  it("limits the environment to env_pass and passes changed files", async () => {
    const parent = { PATH: process.env.PATH, SECRET_TOKEN: "s3cret", NODE_ENV: "test" };
    const c = cfg([{ id: "env", argv: [node, "-e", "console.log(JSON.stringify(process.env))"], scope: "changed" }]);
    const [r] = await runChecks(dir, c, { parentEnv: parent, changedFiles: ["a.ts", "b.ts"] });
    const env = JSON.parse(r!.outputTail);
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.NODE_ENV).toBe("test");
    expect(env.HARNESS_CHANGED_FILES).toBe("a.ts\nb.ts");
    expect(Object.keys(checkEnv(c, parent))).not.toContain("SECRET_TOKEN");
  });

  it("keeps only the last 200 lines", async () => {
    const [r] = await runChecks(dir, cfg([{ id: "loud", argv: [node, "-e", "for (let i=0;i<500;i++) console.log('line '+i)"] }]));
    const lines = r!.outputTail.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.at(-1)).toBe("line 499");
  });

  it("runs setup and stops at the first failure", async () => {
    expect((await runSetup(dir, cfg([], { setup: [{ argv: [node, "-e", "1"] }] }))).ok).toBe(true);
    const r = await runSetup(dir, cfg([], { setup: [{ argv: [node, "-e", "process.exit(3)"] }, { argv: [node, "-e", "1"] }] }));
    expect(r.ok).toBe(false);
  });
});

describe("readiness", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ready-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is ready with checks, tests, AGENTS.md and a green baseline", async () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x");
    const c = cfg([{ id: "unit", argv: [node, "-e", "1"] }]);
    const r = assessReadiness({ root: dir, checks: c, testsFound: 3, baseline: await runChecks(dir, c, { requiredOnly: true }) });
    expect(r.grade).toBe("ready");
    expect(formatReadiness(r)).toContain("Baseline: green");
  });

  it("warns and suggests a test task when there are no tests", () => {
    const r = assessReadiness({ root: dir, checks: cfg([{ id: "lint", argv: ["x"] }]), testsFound: 0 });
    expect(r.grade).toBe("warn");
    expect(r.suggestions.join()).toMatch(/Add test infrastructure/);
    expect(r.suggestions.join()).toMatch(/AGENTS.md/);
  });

  it("blocks on a red baseline", async () => {
    const c = cfg([{ id: "unit", argv: [node, "-e", "process.exit(1)"] }]);
    const r = assessReadiness({ root: dir, checks: c, testsFound: 1, baseline: await runChecks(dir, c) });
    expect(r.grade).toBe("blocked");
    expect(formatReadiness(r)).toContain("Baseline: RED");
  });
});
