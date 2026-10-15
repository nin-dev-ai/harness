import { z } from "zod";
import { TaskSchema, WorkerSchema } from "@harness/core";

/** The stable shape of `harness status --json`. Scripts may rely on these fields. */
export const StatusJsonSchema = z.object({
  project: z.object({ id: z.string(), name: z.string(), root: z.string(), integrationBranch: z.string(), autonomy: z.string() }),
  scheduler: z.object({ running: z.boolean(), until: z.string().nullable(), burst: z.boolean() }),
  now: z.string(),
  workers: z.array(
    WorkerSchema.extend({ vendor: z.string(), route: z.string().nullable(), taskId: z.string().nullable(), taskTitle: z.string().nullable(), runKind: z.string().nullable(), elapsedMs: z.number().nullable() }),
  ),
  tasks: z.array(TaskSchema.extend({ needsHumanReason: z.string().nullable().optional(), lastRunId: z.string().nullable().optional(), delivery: z.enum(["delivered", "blocked", "pending"]).nullable().optional(), childIds: z.array(z.string()).optional() })),
  routes: z.array(
    z.object({
      route: z.string(),
      vendor: z.string(),
      auth: z.string(),
      model: z.string().nullable(),
      pausedUntil: z.string().nullable(),
      pauseSource: z.string().nullable(),
      windows: z.array(
        z.object({
          route: z.string(), vendor: z.string(), kind: z.enum(["5h", "7d", "budget"]), usedPct: z.number().nullable(), display: z.string(), detail: z.string().optional(),
          resetsAt: z.string().nullable(), source: z.enum(["vendor", "manual", "inferred"]), observedAt: z.string(), stale: z.boolean(), capPct: z.number(),
        }),
      ),
    }),
  ),
  approvals: z.array(z.object({ id: z.string(), taskId: z.string().nullable(), category: z.string(), context: z.string() })),
  warnings: z.array(z.string()),
  threads: z.array(z.object({ id: z.string(), primaryRole: z.string(), state: z.enum(["WORKING", "WAITING", "NEEDS_HUMAN", "DELIVERED"]), taskIds: z.array(z.string()), reason: z.string().nullable() })).optional(),
});
export type StatusJson = z.infer<typeof StatusJsonSchema>;
