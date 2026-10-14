import { IllegalTransitionError } from "../errors.js";
import type { WorkerState } from "../schemas/worker.js";

/** Worker slot transitions. Pure; an illegal transition throws. */
export const WORKER_TRANSITIONS: Readonly<Record<WorkerState, readonly WorkerState[]>> = {
  IDLE: ["RUNNING", "WAITING", "PAUSED"],
  WAITING: ["RUNNING", "IDLE", "PAUSED"],
  RUNNING: ["IDLE", "PAUSED", "WAITING", "FAILED"],
  PAUSED: ["RUNNING", "IDLE", "WAITING"],
  FAILED: ["IDLE"],
};

export function canTransitionWorker(from: WorkerState, to: WorkerState): boolean {
  return WORKER_TRANSITIONS[from].includes(to);
}

export function transitionWorker(from: WorkerState, to: WorkerState): WorkerState {
  if (!canTransitionWorker(from, to)) throw new IllegalTransitionError("worker", from, to);
  return to;
}
