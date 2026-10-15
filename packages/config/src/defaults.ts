import { roleGuide, type HarnessConfig, type ModelTiers, type Unattended, type Vendor } from "@harness/core";

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
  if (has("cursor")) routes.push("  cursor:\n    vendor: cursor\n    auth: subscription           # uses your cursor-agent login");
  if (!routes.length) routes.push("  fake:\n    vendor: fake\n    auth: api_key");
  const first = has("claude") ? "claude-sub" : has("codex") ? "codex-sub" : has("cursor") ? "cursor" : "fake";
  const second = has("codex") ? "codex-sub" : first;
  const reviewer = has("cursor") ? "cursor" : has("codex") && first !== "codex-sub" ? "codex-sub" : first;
  return `version: 1
project: ${project}
integration_branch: harness/integration   # task branches merge here, then verified work lands in base_branch
land: auto
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
  /** Default: the CLI's own login (no API key). */
  auth?: "subscription" | "api_key";
  /** What this agent is for. Default: the built-in guide for its role name. */
  instructions?: string;
  /** Other tools this agent may also run on: work goes wherever there is room. */
  pool?: Vendor[];
  /** Model per task size, e.g. { S: "haiku", L: "opus" }. */
  models?: ModelTiers;
}

const ROUTE_NAME: Record<Vendor, string> = { claude: "claude", codex: "codex", cursor: "cursor", fake: "fake" };

/**
 * harness.yaml from wizard answers: one route per (vendor, model), roles bound
 * to them. Cursor routes use an API key; Claude and Codex use the signed-in subscription.
 */
export function configFromWizard(project: string, agents: WizardAgent[]): string {
  const routes = new Map<string, { vendor: Vendor; model?: string; models?: Partial<Record<"S" | "M" | "L", string>>; auth: "subscription" | "api_key" }>();
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const routeFor = (a: WizardAgent) => {
    const base = ROUTE_NAME[a.vendor];
    const tiers = a.models && Object.keys(a.models).length ? a.models : undefined;
    const name = tiers ? `${base}-${slug(Object.values(tiers).join("-"))}` : a.model ? `${base}-${slug(a.model)}` : base;
    routes.set(name, { vendor: a.vendor, auth: a.auth ?? "subscription", ...(a.model ? { model: a.model } : {}), ...(tiers ? { models: tiers } : {}) });
    return name;
  };
  const roleLines: string[] = [];
  const writers = agents.filter((a) => a.mode === "write").map((a) => a.role);
  for (const a of agents) {
    const route = routeFor(a);
    roleLines.push(`  ${a.role}:`, `    route: ${route}`, `    mode: ${a.mode}`);
    // Pool members use each tool's default model: a model id belongs to one vendor.
    const { model: _model, models: _models, ...plain } = a;
    const pool = (a.pool ?? []).filter((v) => v !== a.vendor).map((v) => routeFor({ ...plain, vendor: v }));
    if (pool.length) roleLines.push(`    pool: [${pool.join(", ")}]`);
    const guide = roleGuide(a.role, a.instructions);
    if (guide) roleLines.push(`    instructions: ${JSON.stringify(guide)}`);
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
    if (r.models) routeLines.push(`    models: { ${Object.entries(r.models).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`);
  }
  return `# Made by the harness setup wizard. Edit freely; \`harness config check\` validates it.
version: 1
project: ${project}
integration_branch: harness/integration   # task branches merge here, then verified work lands in base_branch
land: auto
base_branch: main

routes:
${routeLines.join("\n")}

roles:
${roleLines.join("\n")}

limits:
  max_attempts_per_task: 3
  max_task_minutes: 60
  max_parallel_workers: 3
  review_sizes: [M, L]          # small tasks merge once checks pass; add S to review them too

burst:
  enabled: true

policy:
  autonomy: approved-scope
`;
}
