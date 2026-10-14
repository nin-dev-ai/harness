import { HARNESS_BRANCH_PREFIX, HarnessError } from "@harness/core";
import { git, gitRaw, revParse } from "./git.js";

/** The tool writes only to branches under harness/. */
export function assertHarnessBranch(branch: string): void {
  if (!branch.startsWith(HARNESS_BRANCH_PREFIX)) {
    throw new HarnessError("POLICY_DENIED", `refusing to write to branch "${branch}": only ${HARNESS_BRANCH_PREFIX}** branches are written`, { branch });
  }
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await gitRaw(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await gitRaw(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.exitCode === 0 ? r.stdout : null;
}

/** Create the integration branch from the base branch if it does not exist. Returns its head. */
export async function ensureIntegrationBranch(root: string, integration: string, base: string): Promise<string> {
  assertHarnessBranch(integration);
  if (!(await branchExists(root, integration))) {
    await git(root, ["branch", integration, await revParse(root, base)]);
  }
  return revParse(root, integration);
}

export async function listHarnessBranches(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${HARNESS_BRANCH_PREFIX}`]);
  return out ? out.split("\n") : [];
}

export async function deleteBranch(cwd: string, branch: string): Promise<void> {
  assertHarnessBranch(branch);
  await git(cwd, ["branch", "-D", branch]);
}
