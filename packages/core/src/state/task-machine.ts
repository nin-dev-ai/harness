import { IllegalTransitionError } from "../errors.js";
import type { TaskState } from "../schemas/task.js";

/**
 * Task state transitions. Pure; an illegal transition throws.
 * Main path: DRAFT → QUEUED → RUNNING → GATING → REVIEWING → PR_READY → MERGED.
 * Side states and the extra edges beyond the PRD diagram are listed in docs/DECISIONS.md.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ["QUEUED"],
  QUEUED: ["RUNNING", "PAUSED"],
  RUNNING: ["GATING", "PAUSED", "QUEUED", "NEEDS_HUMAN"],
  GATING: ["REVIEWING", "REPAIRING", "NEEDS_HUMAN", "QUEUED"],
  REVIEWING: ["PR_READY", "REPAIRING", "PAUSED", "NEEDS_HUMAN", "QUEUED"],
  REPAIRING: ["GATING", "NEEDS_HUMAN", "PAUSED", "QUEUED"],
  PR_READY: ["MERGED", "NEEDS_HUMAN", "REPAIRING"],
  MERGED: [],
  PAUSED: ["RUNNING", "REPAIRING", "REVIEWING", "QUEUED", "TAKEN_OVER", "NEEDS_HUMAN"],
  NEEDS_HUMAN: ["QUEUED", "REPAIRING", "TAKEN_OVER"],
  TAKEN_OVER: ["QUEUED", "NEEDS_HUMAN", "GATING"],
  CANCELLED: [],
  STALE: ["QUEUED"],
};

/** States from which CANCELLED and STALE are always reachable ("any state"). */
const CANCELLABLE = (s: TaskState) => s !== "CANCELLED" && s !== "MERGED";
const STALEABLE = (s: TaskState) => s !== "CANCELLED" && s !== "STALE" && s !== "DRAFT";

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  if (to === "CANCELLED") return CANCELLABLE(from);
  if (to === "STALE") return STALEABLE(from);
  return TASK_TRANSITIONS[from].includes(to);
}

/** Returns `to` if legal, otherwise throws IllegalTransitionError. */
export function transitionTask(from: TaskState, to: TaskState): TaskState {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError("task", from, to);
  return to;
}

/** Terminal for scheduling purposes. */
export function isTaskTerminal(s: TaskState): boolean {
  return s === "MERGED" || s === "CANCELLED";
}

/** States in which a task holds a worker. */
export function isTaskActive(s: TaskState): boolean {
  return s === "RUNNING" || s === "GATING" || s === "REVIEWING" || s === "REPAIRING";
}
