import { git, gitRaw, identityArgs } from "./git.js";
import { currentBranch, assertHarnessBranch } from "./branch.js";

export async function isDirty(worktree: string): Promise<boolean> {
  return (await git(worktree, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
}

/** Commit everything in the worktree with `message`. Returns the commit sha, or null if there was nothing to commit. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  const branch = await currentBranch(worktree);
  if (!branch) throw new Error(`worktree ${worktree} has a detached HEAD`);
  assertHarnessBranch(branch);
  if (!(await isDirty(worktree))) return null;
  await git(worktree, ["add", "-A"]);
  await git(worktree, [...(await identityArgs(worktree)), "commit", "--no-verify", "-q", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

/** WIP checkpoint: `wip(T-004): checkpoint R-T-004-2`. Squashed away on merge. */
export async function checkpoint(worktree: string, taskId: string, runId: string): Promise<string | null> {
  return commitAll(worktree, `wip(${taskId}): checkpoint ${runId}`);
}

export async function headSha(worktree: string): Promise<string> {
  return git(worktree, ["rev-parse", "HEAD"]);
}

export async function commitsSince(worktree: string, base: string): Promise<string[]> {
  const r = await gitRaw(worktree, ["log", "--format=%s", `${base}..HEAD`]);
  return r.stdout ? r.stdout.split("\n") : [];
}
