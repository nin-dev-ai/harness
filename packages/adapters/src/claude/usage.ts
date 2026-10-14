import type { UsageSnapshot } from "@harness/core";

/**
 * Claude reports both windows in every headless run (rate_limit_event), so
 * usage is whatever the latest run saw. Between runs the snapshot ages and is
 * marked stale by the quota layer; nothing here estimates.
 */
export function mergeWindows(prev: UsageSnapshot[], next: UsageSnapshot[]): UsageSnapshot[] {
  const byKind = new Map(prev.map((s) => [s.window, s]));
  for (const s of next) byKind.set(s.window, s);
  return [...byKind.values()];
}
