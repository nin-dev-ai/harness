import { describe, expect, it } from "vitest";
import { formatTaskId, nextTaskId, parseTaskId, runId, slugify, taskBranch, workerId, worktreePath } from "./ids.js";

describe("ids", () => {
  it("formats and parses task ids", () => {
    expect(formatTaskId(4)).toBe("T-004");
    expect(formatTaskId(1234)).toBe("T-1234");
    expect(parseTaskId("T-012")).toBe(12);
    expect(() => parseTaskId("X-1")).toThrow();
  });
  it("computes the next task id", () => {
    expect(nextTaskId([])).toBe("T-001");
    expect(nextTaskId(["T-001", "T-009", "junk"])).toBe("T-010");
  });
  it("builds run, worker, branch and worktree names", () => {
    expect(runId("T-004", 2)).toBe("R-T-004-2");
    expect(workerId("frontend", 1)).toBe("frontend-1");
    expect(taskBranch("frontend", "T-004", "Watchlist panel!")).toBe("harness/frontend/T-004-watchlist-panel");
    expect(worktreePath("T-004")).toBe(".harness/worktrees/T-004");
  });
  it("slugifies safely", () => {
    expect(slugify("  ")).toBe("task");
    expect(slugify("A very long title that keeps going and going")).toBe("a-very-long-title-that-keeps-goi");
  });
});
