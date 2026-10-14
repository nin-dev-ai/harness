import type { HarnessConfig, Unattended, Vendor } from "@harness/core";

/** Default unattended policy: subscription routes ask, API-key routes allow. */
export function effectiveUnattended(config: HarnessConfig, route: string): Unattended {
  const explicit = config.policy.unattended[route];
  if (explicit) return explicit;
  return config.routes[route]?.auth === "api_key" ? "allow" : "ask";
}

/** Cap for a route window from limits.routes, default 100. */
export function capPct(config: HarnessConfig, route: string, kind: "5h" | "7d" | "budget"): number {
  const l = config.limits.routes[route];
  if (kind === "5h") return l?.window_5h_cap_pct ?? 100;
  if (kind === "7d") return l?.window_7d_cap_pct ?? 100;
  return 100;
}

/** Environment variable an api_key route needs, per vendor. */
export const API_KEY_ENV: Record<Vendor, string | undefined> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
  fake: undefined,
};

/** CLI binary names per vendor, in lookup order. */
export const VENDOR_BINARIES: Record<Vendor, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  cursor: ["agent", "cursor-agent"],
  fake: [],
};

/** A starter harness.yaml for `harness init`, built from the vendors that are installed. */
export function starterConfig(project: string, vendors: Vendor[]): string {
  const has = (v: Vendor) => vendors.includes(v);
  const routes: string[] = [];
  if (has("claude")) routes.push("  claude-sub:\n    vendor: claude\n    auth: subscription");
  if (has("codex")) routes.push("  codex-sub:\n    vendor: codex\n    auth: subscription");
  if (has("cursor")) routes.push("  cursor-key:\n    vendor: cursor\n    auth: api_key                # reads CURSOR_API_KEY");
  if (!routes.length) routes.push("  fake:\n    vendor: fake\n    auth: api_key");
  const first = has("claude") ? "claude-sub" : has("codex") ? "codex-sub" : has("cursor") ? "cursor-key" : "fake";
  const second = has("codex") ? "codex-sub" : first;
  const reviewer = has("cursor") ? "cursor-key" : has("codex") && first !== "codex-sub" ? "codex-sub" : first;
  return `version: 1
project: ${project}
integration_branch: harness/integration   # task branches merge here, never into main
base_branch: main

routes:
${routes.join("\n")}

roles:
  planner:
    route: ${first}
    mode: readonly
    instructions: "Split work into small, independently testable tasks."
  backend:
    route: ${first}
    mode: write
    concurrency: 1
  frontend:
    route: ${second}
    mode: write
    concurrency: 1
  reviewer:
    route: ${reviewer}
    mode: readonly
    independent_of: [frontend, backend]

limits:
  max_attempts_per_task: 3
  max_task_minutes: 60
  max_parallel_workers: 3

burst:
  enabled: true

policy:
  autonomy: approved-scope
`;
}
