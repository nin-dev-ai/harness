/** Probe delays after a limit with no known reset: 15 min, 30 min, 1 h, 2 h, then 4 h. */
export const PROBE_BACKOFF_MS = [15, 30, 60, 120, 240].map((m) => m * 60_000);

export function probeDelay(attempt: number): number {
  return PROBE_BACKOFF_MS[Math.min(attempt, PROBE_BACKOFF_MS.length - 1)]!;
}

/** Random delay in [lo, hi] seconds, as ms. `rng` is injectable for tests. */
export function jitterMs([lo, hi]: readonly [number, number], rng: () => number = Math.random): number {
  return Math.round((lo + (hi - lo) * rng()) * 1000);
}

/** Start of the current budget period for `per` (local day, ISO week from Monday, or rolling 5h). */
export function periodStart(now: Date, per: "day" | "week" | "5h"): Date {
  if (per === "5h") return new Date(now.getTime() - 5 * 3_600_000);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (per === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
