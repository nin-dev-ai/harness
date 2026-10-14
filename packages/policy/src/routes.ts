import type { HarnessConfig, Unattended, Vendor } from "@harness/core";

/** Default unattended setting: subscription routes ask, API-key routes allow. */
export function unattendedSetting(config: HarnessConfig, route: string): Unattended {
  return config.policy.unattended[route] ?? (config.routes[route]?.auth === "api_key" ? "allow" : "ask");
}

export type UnattendedDecision = { ok: true } | { ok: false; action: "deny" | "ask" };

/** May the scheduler dispatch on this route now? Attended runs are always allowed. */
export function unattendedDecision(config: HarnessConfig, route: string, attended: boolean): UnattendedDecision {
  if (attended) return { ok: true };
  const s = unattendedSetting(config, route);
  return s === "allow" ? { ok: true } : { ok: false, action: s };
}

/** Each vendor's own terms; shown when a subscription route is set to unattended `allow`. */
export const VENDOR_TERMS: Record<Vendor, string> = {
  claude: "https://code.claude.com/docs/en/legal-and-compliance",
  codex: "https://openai.com/policies/usage-policies/",
  cursor: "https://cursor.com/terms-of-service",
  fake: "(test vendor)",
};
