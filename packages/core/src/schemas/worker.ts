import { z } from "zod";

export const WorkerStateSchema = z.enum(["IDLE", "RUNNING", "PAUSED", "WAITING", "FAILED"]);
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const WorkerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.string(),
  state: WorkerStateSchema,
  currentRun: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  waitingReason: z.string().nullable().default(null),
});
export type Worker = z.infer<typeof WorkerSchema>;
