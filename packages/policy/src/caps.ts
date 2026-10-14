import type { RouteLimits } from "@harness/core";

/** Does a limits change raise what may be spent (needs approval when proposed by anything but the user)? */
export function isBudgetIncrease(before: RouteLimits | undefined, after: RouteLimits): boolean {
  const up = (a: number | undefined, b: number | undefined) => (b ?? 100) > (a ?? 100);
  if (up(before?.window_5h_cap_pct, after.window_5h_cap_pct) || up(before?.window_7d_cap_pct, after.window_7d_cap_pct)) return true;
  const mb = before?.manual_budget;
  const ma = after.manual_budget;
  if (ma && (!mb || (ma.unit === mb.unit && ma.per === mb.per && ma.amount > mb.amount))) return Boolean(mb);
  return false;
}
