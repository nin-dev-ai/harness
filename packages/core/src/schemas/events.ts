import { z } from "zod";
import { BlockedReasonSchema, TaskStateSchema } from "./task.js";
import { AgentEventSchema, ErrorKindSchema, RunKindSchema, RunStateSchema } from "./run.js";
import { WorkerStateSchema } from "./worker.js";

/**
 * Every event type and its payload. The event log is the source of truth;
 * other tables are projections of it. If it isn't here, it didn't happen.
 */
const s = z.string();
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional();
const windowKind = z.enum(["5h", "7d", "budget", "unknown"]);

export const EVENT_PAYLOADS = {
  // Project
  "project.initialized": z.object({ path: s, name: s }),
  "config.changed": z.object({ file: s, summary: opt(s) }),
  "readiness.reported": z.object({ checks: z.array(s), testsFound: z.number(), agentsMd: z.boolean(), warnings: z.array(s) }),
  "baseline.checked": z.object({ ok: z.boolean(), failed: z.array(s) }),
  // Planning
  "plan.requested": z.object({ source: s }),
  "plan.drafted": z.object({ taskIds: z.array(s) }),
  "plan.invalid": z.object({ errors: z.array(s), attempt: z.number() }),
  "task.routed": z.object({ role: s, reason: s }),
  "model.escalated": z.object({ from: z.enum(["S", "M", "L"]), to: z.enum(["S", "M", "L"]), reason: s }),
  "session.refreshed": z.object({ sessionId: s, tokens: z.number(), budget: z.number() }),
  "team.request": z.object({ text: s, taskIds: z.array(s).default([]) }),
  "lead.reported": z.object({ status: s, followups: z.array(s).default([]), batch: s.optional(), round: z.number().int().default(0), done: z.boolean().default(false) }),
  "plan.reassigned": z.object({ key: s, from: s, to: s, files: z.array(s) }),
  "task.approved": z.object({ by: s.default("user") }),
  // Tasks
  "task.created": z.object({ title: s, role: s, size: z.enum(["S", "M", "L"]), dependsOn: z.array(s), state: TaskStateSchema, specPath: s, attemptsMax: z.number().int().min(1).default(3) }),
  "task.state_changed": z.object({ from: TaskStateSchema, to: TaskStateSchema, reason: opt(s) }),
  "task.blocked": z.object({ reason: BlockedReasonSchema, detail: opt(s) }),
  "task.needs_human": z.object({ reason: s, evidence: z.record(s, z.unknown()).default({}) }),
  "task.updated": z.object({
    fields: z
      .object({
        title: opt(s),
        role: opt(s),
        size: opt(z.enum(["S", "M", "L"])),
        dependsOn: opt(z.array(s)),
        attempts: opt(z.number().int().min(0)),
        attemptsMax: opt(z.number().int().min(1)),
        branch: opt(s.nullable()),
        worktree: opt(s.nullable()),
      })
      .strict(),
  }),
  // Dispatch
  "dispatch.considered": z.object({ dispatched: z.boolean(), reason: opt(BlockedReasonSchema), route: opt(s), predictedCost: opt(z.number().nullable()) }),
  "worker.assigned": z.object({ role: s }),
  "worker.released": z.object({ role: s }),
  "worker.state_changed": z.object({ role: s, from: WorkerStateSchema.nullable(), to: WorkerStateSchema, currentRun: opt(s.nullable()), reason: opt(s.nullable()) }),
  // Runs
  "run.started": z.object({ route: s, vendor: s, model: opt(s.nullable()), kind: RunKindSchema, artifactDir: s, pid: opt(z.number()), sessionId: opt(s), resumeOf: opt(s) }),
  "run.event": z.object({ event: AgentEventSchema }),
  "run.checkpointed": z.object({ commit: s.nullable(), reason: s }),
  "run.resumed": z.object({ sessionId: opt(s), fresh: z.boolean() }),
  "run.taken_over": z.object({ sessionId: opt(s) }),
  "run.finished": z.object({ state: RunStateSchema, exitCode: z.number().nullable(), errorKind: opt(ErrorKindSchema.nullable()), summary: opt(s), sessionId: opt(s) }),
  "run.crashed": z.object({ pid: opt(z.number().nullable()), detail: s }),
  // Verify
  "check.started": z.object({ checkId: s }),
  "check.finished": z.object({ checkId: s, ok: z.boolean(), exitCode: z.number().nullable(), durationMs: z.number(), signature: opt(s.nullable()), outputTail: opt(s), required: opt(z.boolean()) }),
  "gate.passed": z.object({ checks: z.array(s) }),
  "gate.failed": z.object({ failed: z.array(s), signatures: z.array(s), treeHash: opt(s) }),
  "repair.requested": z.object({ attempt: z.number(), cause: z.enum(["gate", "review", "human", "conflict"]), files: z.array(s).optional() }),
  "stall.detected": z.object({ reason: z.enum(["same_signature", "unchanged_diff", "max_attempts"]), detail: opt(s) }),
  // Review
  "review.started": z.object({ route: s, sameRoute: z.boolean() }),
  "review.finding": z.object({ severity: z.enum(["blocker", "major", "nit"]), file: opt(s.nullable()), line: opt(z.number().nullable()), message: s }),
  "review.passed": z.object({ findings: z.number() }),
  "review.blocked": z.object({ blockers: z.number() }),
  // Git
  "worktree.created": z.object({ path: s, branch: s, base: s }),
  "worktree.removed": z.object({ path: s }),
  "integration.landed": z.object({ into: s, mode: z.enum(["fast-forward", "merge"]), commit: s, commits: z.number().int() }),
  "integration.rebuilt": z.object({ kept: s, base: s }),
  "branch.merged": z.object({ branch: s, into: s, commit: s, files: z.array(s).optional() }),
  "merge.conflict": z.object({ branch: s, files: z.array(s) }),
  "pr.opened": z.object({ url: s, branch: s }),
  // Quota
  "window.updated": z.object({ route: s, kind: windowKind, usedPct: z.number().nullable(), resetsAt: s.nullable(), source: z.enum(["vendor", "manual", "inferred"]) }),
  "window.discrepancy": z.object({ route: s, kind: windowKind, vendorPct: z.number(), tallyPct: z.number() }),
  "route.paused": z.object({ route: s, until: s.nullable(), source: z.enum(["event", "vendor", "backoff", "user"]), window: opt(windowKind) }),
  "route.resumed": z.object({ route: s }),
  "probe.sent": z.object({ route: s, ok: z.boolean(), nextProbeAt: opt(s.nullable()) }),
  "budget.cap_reached": z.object({ route: s, kind: windowKind, capPct: z.number() }),
  "cost.sampled": z.object({ route: s, role: s, size: z.enum(["S", "M", "L"]), windowKind: z.enum(["5h", "7d", "budget"]), deltaPct: z.number() }),
  // Policy
  "policy.denied": z.object({ rule: s, detail: s, files: opt(z.array(s)) }),
  "approval.requested": z.object({ approvalId: s, category: s, context: s, action: opt(s) }),
  "approval.granted": z.object({ approvalId: s }),
  "approval.denied": z.object({ approvalId: s, comment: opt(s) }),
  // Chat
  "human.message": z.object({ text: s, target: opt(s) }),
  // Scheduler
  "scheduler.changed": z.object({ running: z.boolean(), burst: opt(z.boolean()), until: opt(s.nullable()), reason: opt(s) }),
  // System
  "daemon.started": z.object({ pid: z.number(), version: s }),
  "daemon.recovered": z.object({ requeued: z.array(s), crashedRuns: z.array(s) }),
  "daemon.stopped": z.object({ reason: s }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;
export type EventPayloadInput<T extends EventType> = z.input<(typeof EVENT_PAYLOADS)[T]>;

const envelope = {
  seq: z.number().int().optional(),
  ts: s,
  projectId: s,
  taskId: s.nullable().optional(),
  runId: s.nullable().optional(),
  workerId: s.nullable().optional(),
};

type EnvelopeOf<T extends EventType> = {
  seq?: number;
  ts: string;
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  workerId?: string | null;
  type: T;
  payload: EventPayload<T>;
};

/** A persisted event: envelope plus a typed payload. */
export type HarnessEvent = { [T in EventType]: EnvelopeOf<T> }[EventType];
export type HarnessEventOf<T extends EventType> = EnvelopeOf<T>;

const variants = EVENT_TYPES.map((t) => z.object({ ...envelope, type: z.literal(t), payload: EVENT_PAYLOADS[t] }));
export const HarnessEventSchema = z.discriminatedUnion(
  "type",
  variants as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
) as unknown as z.ZodType<HarnessEvent>;

/** Build a validated event. Throws on an invalid payload. */
export function makeEvent<T extends EventType>(
  type: T,
  payload: EventPayloadInput<T>,
  env: { ts: string; projectId: string; taskId?: string | null; runId?: string | null; workerId?: string | null },
): HarnessEventOf<T> {
  const parsed = EVENT_PAYLOADS[type].parse(payload) as EventPayload<T>;
  return { ...env, type, payload: parsed };
}
