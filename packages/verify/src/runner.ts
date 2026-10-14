import { execa } from "execa";
import type { Check, ChecksConfig } from "@harness/core";
import { failureSignature } from "./signature.js";

export const TAIL_LINES = 200;

export interface CheckResult {
  checkId: string;
  required: boolean;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** The command could not be started (missing binary, bad cwd). */
  startError: string | null;
  outputTail: string;
  signature: string | null;
}

export interface RunChecksOptions {
  /** Only run required checks (merge re-verification, baseline). */
  requiredOnly?: boolean;
  /** Passed to `scope: changed` checks as HARNESS_CHANGED_FILES (newline separated). */
  changedFiles?: readonly string[];
  /** Environment to draw `env_pass` values from. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  onStart?: (check: Check) => void;
  onFinish?: (result: CheckResult) => void;
  /** Stop after the first failing required check. */
  failFast?: boolean;
}

/** Variables every check gets so commands can be found at all. Nothing else leaks in. */
const BASE_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "SHELL", "USER"];

export function checkEnv(cfg: ChecksConfig, parent: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...cfg.env_pass]) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, CI: env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1", ...extra };
}

function tail(text: string, n = TAIL_LINES): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

/** Run one argv command (no shell) in its own process group, with a hard timeout. */
export async function runCommand(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; startError: string | null; durationMs: number }> {
  const started = Date.now();
  const [cmd, ...args] = argv;
  const sub = execa(cmd!, args, { cwd, env, extendEnv: false, reject: false, all: true, detached: true, stdin: "ignore", stripFinalNewline: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (sub.pid) process.kill(-sub.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, timeoutMs);
  const r = await sub;
  clearTimeout(timer);
  const startError = r.failed && r.exitCode === undefined && !timedOut ? (r.shortMessage ?? "failed to start") : null;
  return {
    exitCode: r.exitCode ?? null,
    output: String(r.all ?? ""),
    timedOut,
    startError,
    durationMs: Date.now() - started,
  };
}

/**
 * Run checks in a worktree, independent of any agent. A required check that
 * fails, times out or cannot start blocks the gate.
 */
export async function runChecks(cwd: string, cfg: ChecksConfig, opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const parent = opts.parentEnv ?? process.env;
  for (const check of cfg.checks) {
    if (opts.requiredOnly && !check.required) continue;
    opts.onStart?.(check);
    const extra: Record<string, string> = {};
    if (check.scope === "changed") extra.HARNESS_CHANGED_FILES = (opts.changedFiles ?? []).join("\n");
    const r = await runCommand(check.argv, cwd, checkEnv(cfg, parent, extra), check.timeout_s * 1000);
    const ok = r.exitCode === 0 && !r.timedOut && !r.startError;
    const outputTail = tail(r.startError ? `${r.output}\n${r.startError}` : r.timedOut ? `${r.output}\n[harness] timed out after ${check.timeout_s}s` : r.output);
    const result: CheckResult = {
      checkId: check.id,
      required: check.required,
      ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      startError: r.startError,
      outputTail,
      signature: ok ? null : failureSignature(check.id, r.timedOut ? "timeout" : outputTail),
    };
    results.push(result);
    opts.onFinish?.(result);
    if (opts.failFast && !ok && check.required) break;
  }
  return results;
}

/** Run `setup` commands from checks.yaml. Returns the first failure, if any. */
export async function runSetup(cwd: string, cfg: ChecksConfig, parentEnv: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; failed?: { argv: readonly string[]; output: string } }> {
  for (const s of cfg.setup) {
    const r = await runCommand(s.argv, cwd, checkEnv(cfg, parentEnv), s.timeout_s * 1000);
    if (r.exitCode !== 0 || r.timedOut || r.startError) return { ok: false, failed: { argv: s.argv, output: tail(`${r.output}\n${r.startError ?? ""}`) } };
  }
  return { ok: true };
}

export interface GateOutcome {
  passed: boolean;
  failedRequired: CheckResult[];
  signatures: string[];
}

/** Gate decision: passes only when every required check passed. */
export function gateOutcome(results: readonly CheckResult[]): GateOutcome {
  const failedRequired = results.filter((r) => r.required && !r.ok);
  return { passed: failedRequired.length === 0, failedRequired, signatures: failedRequired.map((r) => r.signature ?? "").filter(Boolean) };
}
