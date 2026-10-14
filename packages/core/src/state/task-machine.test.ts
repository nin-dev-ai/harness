import { describe, expect, it } from "vitest";
import { TaskStateSchema, type TaskState } from "../schemas/task.js";
import { canTransitionTask, isTaskActive, isTaskTerminal, TASK_TRANSITIONS, transitionTask } from "./task-machine.js";
import { IllegalTransitionError } from "../errors.js";

const ALL = TaskStateSchema.options;

function expected(from: TaskState, to: TaskState): boolean {
  if (to === "CANCELLED") return from !== "CANCELLED" && from !== "MERGED";
  if (to === "STALE") return !["CANCELLED", "STALE", "DRAFT"].includes(from);
  return TASK_TRANSITIONS[from].includes(to);
}

describe("task state machine", () => {
  it("follows the main path", () => {
    const path: TaskState[] = ["DRAFT", "QUEUED", "RUNNING", "GATING", "REVIEWING", "PR_READY", "MERGED"];
    for (let i = 1; i < path.length; i++) expect(transitionTask(path[i - 1]!, path[i]!)).toBe(path[i]);
  });

  it("supports limit, attach, repair and human edges from the PRD", () => {
    const edges: [TaskState, TaskState][] = [
      ["RUNNING", "PAUSED"], ["PAUSED", "RUNNING"], ["PAUSED", "TAKEN_OVER"], ["TAKEN_OVER", "QUEUED"],
      ["GATING", "REPAIRING"], ["REPAIRING", "GATING"], ["REVIEWING", "REPAIRING"],
      ["REPAIRING", "NEEDS_HUMAN"], ["PR_READY", "NEEDS_HUMAN"], ["MERGED", "STALE"], ["RUNNING", "CANCELLED"],
    ];
    for (const [f, t] of edges) expect(canTransitionTask(f, t), `${f}->${t}`).toBe(true);
  });

  // Exhaustive: every pair of states is either legal (returns) or illegal (throws).
  for (const from of ALL) {
    for (const to of ALL) {
      const legal = expected(from, to);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        if (legal) expect(transitionTask(from, to)).toBe(to);
        else expect(() => transitionTask(from, to)).toThrow(IllegalTransitionError);
      });
    }
  }

  it("never skips the gate", () => {
    for (const from of ALL) if (from !== "REVIEWING") expect(canTransitionTask(from, "PR_READY")).toBe(false);
    expect(canTransitionTask("RUNNING", "REVIEWING")).toBe(false);
  });

  it("classifies terminal and active states", () => {
    expect(isTaskTerminal("MERGED")).toBe(true);
    expect(isTaskTerminal("NEEDS_HUMAN")).toBe(false);
    expect(isTaskActive("REPAIRING")).toBe(true);
    expect(isTaskActive("PAUSED")).toBe(false);
  });
});
