import type { GuardFactory } from "./engine.js";
import { PolicyGuard } from "./policy-guard.js";
import { QuotaGuard } from "./quota-guard.js";

/** The guards a real daemon runs with: policy first (cheap, may ask a human), then quota. */
export function defaultGuards(attended: () => boolean): GuardFactory {
  return (p, d, kick) => [new PolicyGuard(p, attended), new QuotaGuard(p, { kick, account: d.accountUsage })];
}
