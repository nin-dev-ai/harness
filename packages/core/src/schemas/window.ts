import { z } from "zod";

/** A usage window on a route. `usedPct: null` means unknown and is never displayed as 0. */
export const WindowSchema = z.object({
  route: z.string(),
  kind: z.enum(["5h", "7d", "budget"]),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  source: z.enum(["vendor", "manual", "inferred"]),
  observedAt: z.string(),
  capPct: z.number().min(0).max(100).default(100),
  pausedUntil: z.string().nullable().default(null),
});
export type Window = z.infer<typeof WindowSchema>;

/** What an adapter reports about a route's usage. */
export const UsageSnapshotSchema = z.object({
  route: z.string(),
  window: z.enum(["5h", "7d", "budget"]),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  source: z.enum(["vendor", "manual", "inferred"]),
  observedAt: z.string(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(observedAt: string, now: Date): boolean {
  return now.getTime() - new Date(observedAt).getTime() > STALE_AFTER_MS;
}

/** Render a used percentage honestly: unknown stays "unknown". */
export function formatUsedPct(usedPct: number | null): string {
  return usedPct === null ? "unknown" : `${Math.round(usedPct)}%`;
}
