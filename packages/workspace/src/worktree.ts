import fs from "node:fs";
import path from "node:path";
import { worktreePath } from "@harness/core";
import { assertHarnessBranch, branchExists } from "./branch.js";
import { git, gitRaw } from "./git.js";

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  const list: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null };
      list.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}

/** Worktree (if any) that has `branch` checked out. */
export async function worktreeForBranch(root: string, branch: string): Promise<WorktreeInfo | undefined> {
  return (await listWorktrees(root)).find((w) => w.branch === branch);
}

/**
 * Create .harness/worktrees/<task> on a new branch from `from`.
 * Idempotent: an existing worktree for the same branch is reused (recovery after a restart).
 */
export async function createWorktree(root: string, taskId: string, branch: string, from: string): Promise<{ path: string; created: boolean }> {
  assertHarnessBranch(branch);
  const rel = worktreePath(taskId);
  const abs = path.join(root, rel);
  const existing = (await listWorktrees(root)).find((w) => fs.existsSync(w.path) && fs.realpathSync(w.path) === (fs.existsSync(abs) ? fs.realpathSync(abs) : abs));
  if (existing) {
    if (existing.branch !== branch) throw new Error(`worktree ${rel} is on ${existing.branch}, expected ${branch}`);
    return { path: abs, created: false };
  }
  await gitRaw(root, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (await branchExists(root, branch)) await git(root, ["worktree", "add", abs, branch]);
  else await git(root, ["worktree", "add", "-b", branch, abs, from]);
  return { path: abs, created: true };
}

/** Remove a task worktree. The branch is kept. */
export async function removeWorktree(root: string, taskId: string): Promise<void> {
  const abs = path.join(root, worktreePath(taskId));
  if (fs.existsSync(abs)) await gitRaw(root, ["worktree", "remove", "--force", abs]);
  await gitRaw(root, ["worktree", "prune"]);
}
