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

/** One agent as chosen in the setup wizard. */
export interface WizardAgent {
  role: string;
  vendor: Vendor;
  model?: string;
  mode: "readonly" | "write";
  pathsAllow?: string[];
  concurrency?: number;
  /** Defaults: Cursor uses an API key, Claude and Codex the signed-in subscription. */
  auth?: "subscription" | "api_key";
}

const ROUTE_NAME: Record<Vendor, string> = { claude: "claude", codex: "codex", cursor: "cursor", fake: "fake" };

/**
 * harness.yaml from wizard answers: one route per (vendor, model), roles bound
 * to them. Cursor routes use an API key; Claude and Codex use the signed-in subscription.
 */
export function configFromWizard(project: string, agents: WizardAgent[]): string {
  const routes = new Map<string, { vendor: Vendor; model?: string; auth: "subscription" | "api_key" }>();
  const routeFor = (a: WizardAgent) => {
    const base = ROUTE_NAME[a.vendor];
    const name = a.model ? `${base}-${a.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : base;
    routes.set(name, { vendor: a.vendor, auth: a.auth ?? (a.vendor === "cursor" ? "api_key" : "subscription"), ...(a.model ? { model: a.model } : {}) });
    return name;
  };
  const roleLines: string[] = [];
  const writers = agents.filter((a) => a.mode === "write").map((a) => a.role);
  for (const a of agents) {
    const route = routeFor(a);
    roleLines.push(`  ${a.role}:`, `    route: ${route}`, `    mode: ${a.mode}`);
    if (a.mode === "write") {
      roleLines.push(`    concurrency: ${a.concurrency ?? 1}`);
      if (a.pathsAllow?.length) roleLines.push(`    paths_allow: [${a.pathsAllow.map((p) => JSON.stringify(p)).join(", ")}]`);
    }
    if (a.role === "reviewer" && writers.length) roleLines.push(`    independent_of: [${writers.join(", ")}]`);
  }
  const routeLines: string[] = [];
  for (const [name, r] of routes) {
    routeLines.push(`  ${name}:`, `    vendor: ${r.vendor}`, `    auth: ${r.auth === "api_key" ? `api_key${r.vendor === "cursor" ? "                # reads CURSOR_API_KEY" : ""}` : "subscription"}`);
    if (r.model) routeLines.push(`    model: ${r.model}`);
  }
  return `# Made by the harness setup wizard. Edit freely; \`harness config check\` validates it.
version: 1
project: ${project}
integration_branch: harness/integration   # task branches merge here, never into main
base_branch: main

routes:
${routeLines.join("\n")}

roles:
${roleLines.join("\n")}

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
