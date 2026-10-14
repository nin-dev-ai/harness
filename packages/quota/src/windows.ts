import { isStale, type Window } from "@harness/core";

export type WindowKind = "5h" | "7d" | "budget";

export interface StoredWindow {
  route: string;
  kind: WindowKind;
  usedPct: number | null;
  resetsAt: string | null;
  source: "vendor" | "manual" | "inferred";
  observedAt: string;
}

const RANK = { vendor: 3, inferred: 2, manual: 1 } as const;

/**
 * Decide whether a new reading replaces the stored one. Vendor data beats
 * inferred beats manual; within a source the newer reading wins. A reading
 * whose window already reset is replaced by anything.
 */
export function shouldReplace(current: StoredWindow | undefined, next: StoredWindow, now: Date): boolean {
  if (!current) return true;
  if (current.resetsAt && new Date(current.resetsAt) <= now) return true;
  if (RANK[next.source] !== RANK[current.source]) return RANK[next.source] > RANK[current.source] || isStale(current.observedAt, now);
  return next.observedAt >= current.observedAt;
}

/** Used percentage that still applies now: a window past its reset counts as 0, unknown stays unknown. */
export function currentUsed(w: StoredWindow | undefined, now: Date): number | null {
  if (!w) return null;
  if (w.resetsAt && new Date(w.resetsAt) <= now) return 0;
  return w.usedPct;
}

export function toWindow(w: StoredWindow, capPct: number, pausedUntil: string | null = null): Window {
  return { ...w, capPct, pausedUntil };
}
