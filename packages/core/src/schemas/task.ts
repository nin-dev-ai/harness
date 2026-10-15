import { z } from "zod";

export const TaskStateSchema = z.enum([
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "GATING",
  "REVIEWING",
  "REPAIRING",
  "PR_READY",
  "MERGED",
  "PAUSED",
  "NEEDS_HUMAN",
  "TAKEN_OVER",
  "CANCELLED",
  "STALE",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSizeSchema = z.enum(["S", "M", "L"]);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

/** Why a ready task was not dispatched. See PRD → Dispatch rule. */
export const BlockedReasonSchema = z.enum([
  "no_worker",
  "window_exhausted",
  "would_not_fit",
  "policy",
  "paused",
  "dependencies",
  "file_overlap",
  "approval",
  "auth",
  "cli_missing",
]);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

const taskId = z.string().regex(/^T-\d{3,}$/);

/** Front matter of .harness/tasks/T-xxx.md. Unknown keys are errors. */
export const TaskFrontMatterSchema = z
  .object({
    id: taskId,
    title: z.string().min(1),
    role: z.string().min(1),
    state: TaskStateSchema.default("DRAFT"),
    depends_on: z.array(taskId).default([]),
    size: TaskSizeSchema.default("M"),
    attempts_max: z.number().int().min(1).default(3),
    acceptance: z.array(z.string()).default([]),
    files_hint: z.array(z.string()).default([]),
    contract_ref: z.string().optional(),
    allow_new_dependencies: z.boolean().default(false),
  })
  .strict();
export type TaskFrontMatter = z.infer<typeof TaskFrontMatterSchema>;

/** A task as stored in the database. */
export const TaskSchema = z.object({
  id: taskId,
  projectId: z.string(),
  title: z.string(),
  role: z.string(),
  state: TaskStateSchema,
  size: TaskSizeSchema,
  dependsOn: z.array(taskId),
  attempts: z.number().int().min(0),
  attemptsMax: z.number().int().min(1),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  specPath: z.string(),
  blockedReason: BlockedReasonSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;
