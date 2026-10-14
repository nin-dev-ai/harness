import type { GuardFactory } from "./engine.js";
import { QuotaGuard } from "./quota-guard.js";

/** The guards a real daemon runs with. Policy (M10) is added alongside quota. */
export const defaultGuards: GuardFactory = (p, _d, kick) => [new QuotaGuard(p, { kick })];
