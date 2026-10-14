import { execa } from "execa";
import { HarnessError } from "@harness/core";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A git command failed. `args` and `stderr` say which and why. */
export class GitError extends HarnessError {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super("INTERNAL", `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
  }
}

/** Variables that would redirect git away from `cwd`; never inherited. */
const STRIP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"];

function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.includes(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extra };
}

/** Run git (argv, no shell). Returns the result; never throws on a non-zero exit. */
export async function gitRaw(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<GitResult> {
  const r = await execa("git", args, {
    cwd,
    env: gitEnv(opts.env),
    extendEnv: false,
    reject: false,
    stripFinalNewline: true,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), exitCode: r.exitCode ?? 1 };
}

/** Run git and return stdout; throws GitError on failure. */
export async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const r = await gitRaw(cwd, args, opts);
  if (r.exitCode !== 0) throw new GitError(args, r);
  return r.stdout;
}

/** Identity flags for commits made by the tool, used only when the repo has none configured. */
export async function identityArgs(cwd: string): Promise<string[]> {
  const email = await gitRaw(cwd, ["config", "user.email"]);
  const name = await gitRaw(cwd, ["config", "user.name"]);
  const out: string[] = [];
  if (!name.stdout.trim()) out.push("-c", "user.name=harness");
  if (!email.stdout.trim()) out.push("-c", "user.email=harness@localhost");
  return out;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitRaw(dir, ["rev-parse", "--is-inside-work-tree"])).stdout === "true";
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitRaw(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).exitCode === 0;
}
