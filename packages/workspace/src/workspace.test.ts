import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../../../tests/helpers/temp-repo.js";
import { assertHarnessBranch, branchExists, ensureIntegrationBranch, listHarnessBranches } from "./branch.js";
import { checkpoint, commitAll, commitsSince, isDirty } from "./checkpoint.js";
import { changedFiles, diffSummary, diffText, revertPaths, workingTreeHash } from "./diff.js";
import { mergeTask } from "./merge.js";
import { createWorktree, listWorktrees, removeWorktree } from "./worktree.js";

const INT = "harness/integration";

describe("workspace", () => {
  let repo: TempRepo;
  let mainHead: string;
  beforeEach(async () => {
    repo = createTempRepo({ "README.md": "# demo\n", "src/shared.ts": "export const x = 1;\n" });
    mainHead = repo.git("rev-parse", "main");
    await ensureIntegrationBranch(repo.root, INT, "main");
  });
  afterEach(() => {
    // The tool never writes main.
    expect(repo.git("rev-parse", "main")).toBe(mainHead);
    repo.cleanup();
  });

  async function task(id: string, branch: string) {
    const { path: wt } = await createWorktree(repo.root, id, branch, INT);
    return wt;
  }

  it("refuses to write outside harness/**", async () => {
    expect(() => assertHarnessBranch("main")).toThrow(/refusing/);
    await expect(createWorktree(repo.root, "T-001", "feature/x", INT)).rejects.toThrow(/refusing/);
    await expect(ensureIntegrationBranch(repo.root, "integration", "main")).rejects.toThrow(/refusing/);
  });

  it("creates an idempotent worktree on its own branch", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    expect(wt).toBe(path.join(repo.root, ".harness/worktrees/T-001"));
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    const again = await createWorktree(repo.root, "T-001", "harness/backend/T-001-a", INT);
    expect(again.created).toBe(false);
    expect((await listWorktrees(repo.root)).some((w) => w.branch === "harness/backend/T-001-a")).toBe(true);
    expect(await listHarnessBranches(repo.root)).toEqual(["harness/backend/T-001-a", INT]);
  });

  it("checkpoints uncommitted work and reports changes", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    expect(await checkpoint(wt, "T-001", "R-T-001-1")).toBeNull();
    fs.writeFileSync(path.join(wt, "src/new.ts"), "export const y = 2;\n");
    fs.writeFileSync(path.join(wt, "src/shared.ts"), "export const x = 2;\n");
    expect(await changedFiles(wt, INT)).toEqual(["src/new.ts", "src/shared.ts"]);
    const s = await diffSummary(wt, INT);
    expect(s).toMatchObject({ insertions: 2, deletions: 1 });
    expect(await diffText(wt, INT)).toContain("+export const y = 2;");
    expect(await isDirty(wt)).toBe(true); // summary must not stage anything
    const sha = await checkpoint(wt, "T-001", "R-T-001-1");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitsSince(wt, INT)).toEqual(["wip(T-001): checkpoint R-T-001-1"]);
    expect(await changedFiles(wt, INT)).toEqual(["src/new.ts", "src/shared.ts"]);
  });

  it("hashes the working state to detect unchanged diffs", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    const h0 = await workingTreeHash(wt);
    fs.writeFileSync(path.join(wt, "a.txt"), "a");
    const h1 = await workingTreeHash(wt);
    expect(h1).not.toBe(h0);
    await commitAll(wt, "add a");
    expect(await workingTreeHash(wt)).toBe(h1);
  });

  it("reverts out-of-scope files, committed or not", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    fs.writeFileSync(path.join(wt, "src/shared.ts"), "changed\n");
    fs.writeFileSync(path.join(wt, "secret.txt"), "x");
    await commitAll(wt, "agent commit");
    fs.writeFileSync(path.join(wt, "untracked.txt"), "y");
    await revertPaths(wt, ["src/shared.ts", "secret.txt", "untracked.txt"], INT);
    expect(await changedFiles(wt, INT)).toEqual([]);
    expect(fs.readFileSync(path.join(wt, "src/shared.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  it("squashes and fast-forwards into the integration branch", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    fs.writeFileSync(path.join(wt, "a.ts"), "a\n");
    await checkpoint(wt, "T-001", "R-T-001-1");
    fs.writeFileSync(path.join(wt, "b.ts"), "b\n");
    let verified = false;
    const r = await mergeTask({ root: repo.root, worktree: wt, branch: "harness/backend/T-001-a", integration: INT, message: "T-001: add a and b", verify: async () => ((verified = true), { ok: true }) });
    expect(r.status).toBe("merged");
    expect(verified).toBe(true);
    expect(repo.git("log", "--format=%s", `main..${INT}`)).toBe("T-001: add a and b");
    expect(repo.git("show", `${INT}:b.ts`)).toBe("b");
  });

  it("starts dependent tasks from an integration branch that contains merged work", async () => {
    const wt1 = await task("T-001", "harness/backend/T-001-a");
    fs.writeFileSync(path.join(wt1, "contract.ts"), "export type Q = 1;\n");
    await mergeTask({ root: repo.root, worktree: wt1, branch: "harness/backend/T-001-a", integration: INT, message: "T-001" });
    const wt2 = await task("T-002", "harness/frontend/T-002-b");
    expect(fs.existsSync(path.join(wt2, "contract.ts"))).toBe(true);
  });

  it("rebases onto work merged meanwhile", async () => {
    const wt1 = await task("T-001", "harness/backend/T-001-a");
    const wt2 = await task("T-002", "harness/frontend/T-002-b");
    fs.writeFileSync(path.join(wt1, "one.ts"), "1\n");
    fs.writeFileSync(path.join(wt2, "two.ts"), "2\n");
    expect((await mergeTask({ root: repo.root, worktree: wt1, branch: "harness/backend/T-001-a", integration: INT, message: "T-001" })).status).toBe("merged");
    expect((await mergeTask({ root: repo.root, worktree: wt2, branch: "harness/frontend/T-002-b", integration: INT, message: "T-002" })).status).toBe("merged");
    expect(repo.git("log", "--format=%s", `main..${INT}`).split("\n")).toEqual(["T-002", "T-001"]);
  });

  it("reports conflicts with the files listed and resolves nothing", async () => {
    const wt1 = await task("T-001", "harness/backend/T-001-a");
    const wt2 = await task("T-002", "harness/frontend/T-002-b");
    fs.writeFileSync(path.join(wt1, "src/shared.ts"), "export const x = 'one';\n");
    fs.writeFileSync(path.join(wt2, "src/shared.ts"), "export const x = 'two';\n");
    await mergeTask({ root: repo.root, worktree: wt1, branch: "harness/backend/T-001-a", integration: INT, message: "T-001" });
    const intHead = repo.git("rev-parse", INT);
    const r = await mergeTask({ root: repo.root, worktree: wt2, branch: "harness/frontend/T-002-b", integration: INT, message: "T-002" });
    expect(r).toEqual({ status: "conflict", files: ["src/shared.ts"] });
    expect(repo.git("rev-parse", INT)).toBe(intHead);
    expect(fs.readFileSync(path.join(wt2, "src/shared.ts"), "utf8")).toContain("two");
    expect(fs.existsSync(path.join(wt2, ".git"))).toBe(true);
  });

  it("does not fast-forward when re-verification fails", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    fs.writeFileSync(path.join(wt, "a.ts"), "a\n");
    const before = repo.git("rev-parse", INT);
    const r = await mergeTask({ root: repo.root, worktree: wt, branch: "harness/backend/T-001-a", integration: INT, message: "T-001", verify: async () => ({ ok: false, detail: "unit failed" }) });
    expect(r).toEqual({ status: "checks_failed", detail: "unit failed" });
    expect(repo.git("rev-parse", INT)).toBe(before);
  });

  it("returns empty when there is nothing to merge, and cleans up worktrees", async () => {
    const wt = await task("T-001", "harness/backend/T-001-a");
    expect((await mergeTask({ root: repo.root, worktree: wt, branch: "harness/backend/T-001-a", integration: INT, message: "T-001" })).status).toBe("empty");
    await removeWorktree(repo.root, "T-001");
    expect(fs.existsSync(wt)).toBe(false);
    expect(await branchExists(repo.root, "harness/backend/T-001-a")).toBe(true);
  });
});
