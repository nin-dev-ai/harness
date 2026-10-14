import type { BlockedReason, RunKind, Task } from "@harness/core";
import type { CheckResult } from "@harness/verify";
import type { ProjectRuntime } from "./project.js";
import type { RunOutcome } from "./supervisor.js";
import type { WorkKind } from "./scheduler.js";

export interface DispatchContext {
  project: ProjectRuntime;
  task: Task;
  kind: WorkKind;
  route: string;
  /** Live runs on this route right now (for in-flight cost). */
  liveOnRoute: { taskId: string; kind: RunKind }[];
  /** A person is attached (UI open or a recent command). */
  attended: boolean;
}

export type GuardDecision = { ok: true } | { ok: false; reason: BlockedReason; detail?: string };

export interface GateContext {
  project: ProjectRuntime;
  task: Task;
  worktree: string;
  base: string;
  changedFiles: string[];
  runId: string | null;
}

/**
 * Hooks the engine calls at fixed points. Quota (M9) and policy (M10) are
 * guards; the engine itself stays free of their rules.
 */
export interface Guard {
  name: string;
  /** May this item be dispatched on this route now? */
  canDispatch?(ctx: DispatchContext): GuardDecision | Promise<GuardDecision>;
  /** Before checks run: may revert files and return synthetic failed checks. */
  beforeGate?(ctx: GateContext): Promise<CheckResult[]>;
  /** A run hit a usage limit: decide and record when the route resumes. */
  onLimit?(project: ProjectRuntime, route: string, outcome: RunOutcome): void | Promise<void>;
  /** A run ended (any state): record measurements. */
  onRunFinished?(project: ProjectRuntime, task: Task, route: string, kind: RunKind, outcome: RunOutcome): void | Promise<void>;
  /** May a PR_READY task merge into the integration branch without `review --accept`? */
  mayAutoMerge?(project: ProjectRuntime, task: Task, changedFiles: string[]): boolean | Promise<boolean>;
}
