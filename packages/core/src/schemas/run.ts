import { z } from "zod";
import { VendorSchema } from "./config.js";

export const RunKindSchema = z.enum(["initial", "repair", "resume", "review", "plan"]);
export type RunKind = z.infer<typeof RunKindSchema>;

export const RunStateSchema = z.enum([
  "STARTING",
  "RUNNING",
  "PAUSED",
  "TAKEN_OVER",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const ErrorKindSchema = z.enum([
  "auth",
  "rate_limit",
  "quota_exhausted",
  "network",
  "cli_missing",
  "cli_version",
  "bad_output",
  "timeout",
  "crashed",
  "session_expired",
  "unknown",
]);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const RunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  route: z.string(),
  vendor: VendorSchema,
  model: z.string().nullable(),
  kind: RunKindSchema,
  vendorSessionId: z.string().nullable(),
  pid: z.number().int().nullable(),
  state: RunStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorKind: ErrorKindSchema.nullable(),
  usageDelta: z.record(z.string(), z.number()).nullable(),
  artifactDir: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const WindowKindSchema = z.enum(["5h", "7d", "unknown"]);

/** Normalized agent events emitted by every adapter. A run's stream always ends with `exited`. */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), runId: z.string(), sessionId: z.string().optional(), pid: z.number().int() }),
  z.object({ type: z.literal("message"), runId: z.string(), text: z.string(), raw: z.unknown().optional() }),
  z.object({ type: z.literal("tool_call"), runId: z.string(), tool: z.string(), summary: z.string() }),
  z.object({ type: z.literal("file_change"), runId: z.string(), path: z.string() }),
  z.object({
    type: z.literal("usage"),
    runId: z.string(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal("rate_limit"), runId: z.string(), window: WindowKindSchema, resetsAt: z.string().optional() }),
  z.object({
    type: z.literal("result"),
    runId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    structured: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    kind: ErrorKindSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({ type: z.literal("exited"), runId: z.string(), code: z.number().int().nullable(), signal: z.string().nullable() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];
