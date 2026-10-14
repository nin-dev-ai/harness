import fs from "node:fs";
import path from "node:path";
import type { ChecksConfig } from "@harness/core";
import { gateOutcome, runChecks, type CheckResult } from "./runner.js";

export interface ReadinessReport {
  checks: { id: string; required: boolean; argv: string[] }[];
  hasTestCheck: boolean;
  testsFound: number;
  agentsMd: boolean;
  baseline: { ok: boolean; results: CheckResult[] } | null;
  warnings: string[];
  suggestions: string[];
  /** ready: can run; warn: can run with warnings; blocked: refuses to start. */
  grade: "ready" | "warn" | "blocked";
}

export interface ReadinessInput {
  root: string;
  checks: ChecksConfig;
  testsFound: number;
  /** Results of running required checks on the base branch, if a baseline was taken. */
  baseline?: CheckResult[];
}

/** Grade the repo's ability to give a useful signal. Pure apart from checking AGENTS.md exists. */
export function assessReadiness(input: ReadinessInput): ReadinessReport {
  const { checks, testsFound } = input;
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const agentsMd = fs.existsSync(path.join(input.root, "AGENTS.md"));
  const hasTestCheck = checks.checks.some((c) => /test|unit|spec|e2e/i.test(c.id));
  const required = checks.checks.filter((c) => c.required);

  if (!checks.checks.length) warnings.push("No checks configured: the loop cannot verify anything.");
  else if (!required.length) warnings.push("No required checks: the gate can never fail.");
  if (!hasTestCheck) warnings.push("No test check found.");
  if (testsFound === 0) {
    warnings.push("No test files found.");
    suggestions.push("Make the first task: Add test infrastructure and tests for <area>.");
  }
  if (!agentsMd) suggestions.push("Create AGENTS.md with repo conventions (harness can draft one).");

  let baseline: ReadinessReport["baseline"] = null;
  let blocked = false;
  if (input.baseline) {
    const g = gateOutcome(input.baseline);
    baseline = { ok: g.passed, results: input.baseline };
    if (!g.passed) {
      blocked = true;
      warnings.push(`Baseline is red: ${g.failedRequired.map((r) => r.checkId).join(", ")} fail on the base branch before any agent runs.`);
    }
  }
  const grade = blocked ? "blocked" : warnings.length ? "warn" : "ready";
  return {
    checks: checks.checks.map((c) => ({ id: c.id, required: c.required, argv: [...c.argv] })),
    hasTestCheck, testsFound, agentsMd, baseline, warnings, suggestions, grade,
  };
}

/** Run the required checks in `cwd` (a checkout of the base branch) to establish the baseline. */
export async function checkBaseline(cwd: string, checks: ChecksConfig): Promise<CheckResult[]> {
  return runChecks(cwd, checks, { requiredOnly: true });
}
