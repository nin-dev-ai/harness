import { remaining5hWindows, weeklyPerWindow, type QuietHours } from "./weekly-pacing.js";

export interface HeadroomInput {
  now: Date;
  used5h: number | null;
  used7d: number | null;
  weeklyResetsAt: string | null;
  cap5h: number;
  cap7d: number;
  safetyMarginPct: number;
  weeklyReservePct: number;
  quiet?: QuietHours | undefined;
}

export interface Headroom {
  /** null = unknown (no usable data on either window). */
  usable: number | null;
  headroom5h: number | null;
  weeklyPerWindow: number | null;
  windowsLeft: number | null;
}

/**
 * headroom_5h = min(cap_5h, 100 - safety_margin) - used_5h
 * weekly_per_window = (min(cap_7d, 100 - weekly_reserve) - used_7d) / remaining 5h windows until the 7d reset
 * usable = min of the known terms; unknown terms are skipped, never treated as 0.
 */
export function usableHeadroom(i: HeadroomInput): Headroom {
  const headroom5h = i.used5h === null ? null : Math.min(i.cap5h, 100 - i.safetyMarginPct) - i.used5h;
  let wpw: number | null = null;
  let windowsLeft: number | null = null;
  if (i.used7d !== null) {
    windowsLeft = i.weeklyResetsAt ? remaining5hWindows(i.now, new Date(i.weeklyResetsAt), i.quiet) : 1;
    wpw = weeklyPerWindow(i.used7d, i.cap7d, i.weeklyReservePct, windowsLeft);
  }
  const known = [headroom5h, wpw].filter((x): x is number => x !== null);
  return { usable: known.length ? round(Math.min(...known)) : null, headroom5h, weeklyPerWindow: wpw === null ? null : round(wpw), windowsLeft };
}

export type FitDecision = { ok: true } | { ok: false; reason: "window_exhausted" | "would_not_fit"; detail: string };

/**
 * The dispatch rule: never start work predicted not to finish inside the
 * remaining headroom (after work already in flight on the route).
 */
export function fits(predictedP80: number, usable: number, inFlight: number): FitDecision {
  if (usable <= 0) return { ok: false, reason: "window_exhausted", detail: `no headroom (${round(usable)}% usable)` };
  const left = usable - inFlight;
  if (predictedP80 > left) return { ok: false, reason: "would_not_fit", detail: `needs ~${round(predictedP80)}%, ${round(Math.max(0, left))}% left after in-flight work` };
  return { ok: true };
}

export interface BudgetInput {
  unit: "runs" | "minutes" | "pct";
  amount: number;
  used: number;
}

/** Manual budget check: runs or minutes used in the period vs. the amount. */
export function budgetLeft(b: BudgetInput): { usedPct: number; left: number } {
  return { usedPct: round((b.used / b.amount) * 100), left: b.amount - b.used };
}

const round = (x: number) => Math.round(x * 100) / 100;
