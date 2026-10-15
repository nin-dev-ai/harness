import { assertHarnessBranch } from "./branch.js";
import { commitAll } from "./checkpoint.js";
import { git, gitRaw, identityArgs, isAncestor, revParse } from "./git.js";
import { worktreeForBranch } from "./worktree.js";

export type MergeResult =
  | { status: "merged"; commit: string }
  | { status: "empty" }
  | { status: "conflict"; files: string[] }
  | { status: "checks_failed"; detail: string };

export interface MergeOptions {
  root: string;
  worktree: string;
  branch: string;
  integration: string;
  /** Final commit message; WIP checkpoints are squashed into it. */
  message: string;
  /** Re-run required checks on the rebased result before fast-forwarding. */
  verify?: (worktree: string) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Rebase the task branch onto the integration branch, squash it into one
 * commit, re-verify, then fast-forward the integration branch.
 * Conflicts are never auto-resolved: the rebase is aborted and the files listed.
 */
export async function mergeTask(o: MergeOptions): Promise<MergeResult> {
  assertHarnessBranch(o.branch);
  assertHarnessBranch(o.integration);
  await commitAll(o.worktree, `wip: pre-merge`);
  const id = await identityArgs(o.worktree);

  const rebase = await gitRaw(o.worktree, [...id, "rebase", o.integration]);
  if (rebase.exitCode !== 0) {
    const conflicted = await gitRaw(o.worktree, ["diff", "--name-only", "--diff-filter=U"]);
    await gitRaw(o.worktree, ["rebase", "--abort"]);
    const files = conflicted.stdout.split("\n").filter(Boolean);
    return { status: "conflict", files: files.length ? files : ["(unknown: rebase failed)"] };
  }

  const integrationHead = await revParse(o.root, o.integration);
  const head = await git(o.worktree, ["rev-parse", "HEAD"]);
  if (head === integrationHead) return { status: "empty" };

  // Squash everything since the integration head into one commit.
  await git(o.worktree, ["reset", "--soft", integrationHead]);
  await git(o.worktree, [...id, "commit", "--no-verify", "-q", "--allow-empty", "-m", o.message]);
  const squashed = await git(o.worktree, ["rev-parse", "HEAD"]);

  if (o.verify) {
    const v = await o.verify(o.worktree);
    if (!v.ok) return { status: "checks_failed", detail: v.detail ?? "required checks failed after rebase" };
  }

  // Fast-forward only. Someone else may have advanced the integration branch meanwhile.
  const now = await revParse(o.root, o.integration);
  if (now !== integrationHead || !(await isAncestor(o.root, integrationHead, squashed))) {
    return { status: "conflict", files: ["(integration branch moved during merge; retry)"] };
  }
  const checkedOut = await worktreeForBranch(o.root, o.integration);
  if (checkedOut) await git(checkedOut.path, ["merge", "--ff-only", "-q", squashed]);
  else await git(o.root, ["update-ref", `refs/heads/${o.integration}`, squashed, integrationHead]);
  return { status: "merged", commit: squashed };
}

export type ReplayResult = { status: "clean" } | { status: "conflicts"; files: string[]; previousHead: string } | { status: "failed"; detail: string };

/**
 * Start a task over on the current integration branch, carrying its whole
 * change as one patch (`git apply --3way`). Conflicting hunks are left in the
 * files as conflict markers for the task's agent to resolve; no rebase or
 * merge is left in progress, so any vendor's sandbox can finish it with plain
 * file edits. The previous head is returned (and stays in the reflog); on any
 * other failure the branch is put back exactly as it was.
 */
export async function replayOnIntegration(worktree: string, integration: string): Promise<ReplayResult> {
  assertHarnessBranch(integration);
  await commitAll(worktree, "wip: before replay on integration");
  const previousHead = await git(worktree, ["rev-parse", "HEAD"]);
  const base = await git(worktree, ["merge-base", "HEAD", integration]);
  const patch = await git(worktree, ["diff", "--binary", base, "HEAD"]);
  await git(worktree, ["reset", "-q", "--hard", integration]);
  if (!patch.trim()) return { status: "clean" };
  const r = await gitRaw(worktree, ["apply", "--3way", "--whitespace=nowarn", "-"], { input: `${patch}\n` });
  const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
  if (r.exitCode === 0 && !files.length) return { status: "clean" };
  if (files.length) return { status: "conflicts", files, previousHead };
  await git(worktree, ["reset", "-q", "--hard", previousHead]);
  return { status: "failed", detail: (r.stderr || r.stdout).trim().slice(0, 500) };
}

/** Files that still contain conflict markers. */
export async function filesWithConflictMarkers(worktree: string, files: string[]): Promise<string[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return files.filter((f) => {
    try {
      return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(worktree, f), "utf8"));
    } catch {
      return false;
    }
  });
}
