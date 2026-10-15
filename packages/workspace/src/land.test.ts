import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../../../tests/helpers/temp-repo.js";
import { ensureIntegrationBranch } from "./branch.js";
import { landIntegration, rebuildOrphanedIntegration, unlandedCount } from "./land.js";

const INT = "harness/integration";

/** M23: landing is explicit, never rewrites history, and never resolves conflicts. */
describe("land", () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = createTempRepo({ "README.md": "# demo\n" });
    await ensureIntegrationBranch(repo.root, INT, "main");
  });
  afterEach(() => repo.cleanup());

  const onIntegration = (file: string, content: string) => {
    repo.git("checkout", "-q", INT);
    repo.write(file, content);
    repo.commit(`add ${file}`);
    repo.git("checkout", "-q", "main");
  };

  it("fast-forwards main when it has not moved, and says when there is nothing to land", async () => {
    expect(await landIntegration(repo.root, INT, "main")).toMatchObject({ status: "nothing" });
    onIntegration("a.ts", "a\n");
    expect(await unlandedCount(repo.root, INT, "main")).toBe(1);
    const r = await landIntegration(repo.root, INT, "main");
    expect(r).toMatchObject({ status: "landed", mode: "fast-forward", commits: 1 });
    expect(repo.git("rev-parse", "main")).toBe(repo.git("rev-parse", INT));
    expect(await unlandedCount(repo.root, INT, "main")).toBe(0);
  });

  it("merges when main moved on; refuses a dirty tree; aborts on conflict", async () => {
    onIntegration("a.ts", "from agents\n");
    repo.write("b.ts", "mine\n");
    repo.commit("my own work");
    repo.write("README.md", "# edited, not committed\n");
    expect(await landIntegration(repo.root, INT, "main")).toMatchObject({ status: "refused" });
    repo.git("checkout", "--", "README.md");
    expect(await landIntegration(repo.root, INT, "main")).toMatchObject({ status: "landed", mode: "merge" });
    expect(repo.git("log", "-1", "--format=%s", "main")).toBe(`Land ${INT} into main`);

    onIntegration("c.ts", "agents\n");
    repo.write("c.ts", "me\n");
    repo.commit("conflicting c");
    const before = repo.git("rev-parse", "main");
    expect(await landIntegration(repo.root, INT, "main")).toEqual({ status: "conflict", files: ["c.ts"] });
    expect(repo.git("rev-parse", "main")).toBe(before);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("when main is not checked out it only fast-forwards", async () => {
    onIntegration("a.ts", "a\n");
    repo.git("checkout", "-q", "-b", "other");
    expect(await landIntegration(repo.root, INT, "main")).toMatchObject({ status: "landed", mode: "fast-forward" });
  });

  it("an integration branch with no shared history is kept aside and rebuilt from main", async () => {
    repo.git("checkout", "-q", "--orphan", "rewritten");
    repo.commit("new root");
    repo.git("branch", "-f", "main", "rewritten");
    repo.git("checkout", "-q", "main");
    const kept = await rebuildOrphanedIntegration(repo.root, INT, "main", "2026-10-15T10:20:30.000Z");
    expect(kept).toBe(`${INT}-orphaned-20261015102030`);
    expect(repo.git("rev-parse", INT)).toBe(repo.git("rev-parse", "main"));
    expect(await rebuildOrphanedIntegration(repo.root, INT, "main", "x")).toBeUndefined();
  });
});
