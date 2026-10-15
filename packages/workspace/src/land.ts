import { assertHarnessBranch, branchExists, currentBranch } from "./branch.js";
import { git, gitRaw, identityArgs, isAncestor, revParse } from "./git.js";

/**
 * Landing is the one place harness writes a branch outside harness/**, and
 * it only runs when the person asks (`harness land`, `/land`). It never
 * rewrites history: fast-forward when possible, otherwise a merge commit, and
 * a conflict is aborted and reported, never resolved.
 */

export type LandResult =
  | { status: "landed"; mode: "fast-forward" | "merge"; commit: string; commits: number }
  | { status: "nothing"; detail: string }
  | { status: "refused"; detail: string }
  | { status: "conflict"; files: string[] };

/** Commits on `integration` that `base` does not have. */
export async function unlandedCount(root: string, integration: string, base: string): Promise<number> {
  if (!(await branchExists(root, integration)) || !(await branchExists(root, base))) return 0;
  if (!(await sharesHistory(root, integration, base))) return 0;
  return Number(await git(root, ["rev-list", "--count", `${base}..${integration}`]));
}

export async function sharesHistory(root: string, a: string, b: string): Promise<boolean> {
  return (await gitRaw(root, ["merge-base", a, b])).exitCode === 0;
}

export async function landIntegration(root: string, integration: string, base: string): Promise<LandResult> {
  assertHarnessBranch(integration);
  if (!(await branchExists(root, integration))) return { status: "nothing", detail: `${integration} does not exist yet` };
  if (!(await branchExists(root, base))) return { status: "refused", detail: `base branch ${base} does not exist` };
  if (!(await sharesHistory(root, integration, base))) return { status: "refused", detail: `${integration} shares no history with ${base}; restart harness to rebuild it from ${base}` };
  const commits = Number(await git(root, ["rev-list", "--count", `${base}..${integration}`]));
  if (commits === 0) return { status: "nothing", detail: `${base} already has everything on ${integration}` };
  const ff = await isAncestor(root, base, integration);
  const onBase = (await currentBranch(root)) === base;

  if (!onBase) {
    // Not checked out: only a fast-forward is safe without touching anyone's files.
    if (!ff) return { status: "refused", detail: `${base} has moved on; check out ${base} and land again to merge` };
    await git(root, ["update-ref", `refs/heads/${base}`, await revParse(root, integration), await revParse(root, base)]);
    return { status: "landed", mode: "fast-forward", commit: await revParse(root, base), commits };
  }

  const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) return { status: "refused", detail: `${base} has uncommitted changes; commit or stash them first` };
  if (ff) {
    await git(root, ["merge", "--ff-only", integration]);
    return { status: "landed", mode: "fast-forward", commit: await revParse(root, "HEAD"), commits };
  }
  const r = await gitRaw(root, [...(await identityArgs(root)), "merge", "--no-ff", "--no-edit", "-m", `Land ${integration} into ${base}`, integration]);
  if (r.exitCode !== 0) {
    const files = (await git(root, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
    await gitRaw(root, ["merge", "--abort"]);
    return { status: "conflict", files };
  }
  return { status: "landed", mode: "merge", commit: await revParse(root, "HEAD"), commits };
}

/**
 * An integration branch that shares no history with the base (the base was
 * rewritten) can never land. Keep it under a dated name and start a fresh one
 * from the base. Returns the name the old branch was kept under, if any.
 */
export async function rebuildOrphanedIntegration(root: string, integration: string, base: string, stamp: string): Promise<string | undefined> {
  assertHarnessBranch(integration);
  if (!(await branchExists(root, integration)) || !(await branchExists(root, base))) return undefined;
  if (await sharesHistory(root, integration, base)) return undefined;
  const kept = `${integration}-orphaned-${stamp.replace(/[^0-9]/g, "").slice(0, 14)}`;
  assertHarnessBranch(kept);
  await git(root, ["branch", "-m", integration, kept]);
  await git(root, ["branch", integration, await revParse(root, base)]);
  return kept;
}
