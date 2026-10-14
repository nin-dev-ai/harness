import { describe, expect, it } from "vitest";
import { WorkerStateSchema } from "../schemas/worker.js";
import { transitionWorker, WORKER_TRANSITIONS } from "./worker-machine.js";
import { IllegalTransitionError } from "../errors.js";

describe("worker state machine", () => {
  for (const from of WorkerStateSchema.options) {
    for (const to of WorkerStateSchema.options) {
      const legal = WORKER_TRANSITIONS[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        if (legal) expect(transitionWorker(from, to)).toBe(to);
        else expect(() => transitionWorker(from, to)).toThrow(IllegalTransitionError);
      });
    }
  }
});
