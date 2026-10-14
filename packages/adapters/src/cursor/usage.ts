import type { UsageSnapshot } from "@harness/core";

/**
 * Cursor exposes no plan usage to third parties (M5). The adapter reports
 * nothing; the quota layer shows `unknown` plus the user's manual budget.
 */
export function cursorUsage(): UsageSnapshot[] {
  return [];
}
