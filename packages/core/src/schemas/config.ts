import { z } from "zod";

/** Schemas for harness.yaml and .harness/checks.yaml. Unknown keys are errors (strict). */

export const VendorSchema = z.enum(["claude", "codex", "cursor", "fake"]);
export type Vendor = z.infer<typeof VendorSchema>;

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes, starting with a letter");

export const RouteSchema = z
  .object({
    vendor: VendorSchema,
    auth: z.enum(["subscription", "api_key"]),
    model: z.string().optional(),
    /** Model per task size (S, M, L); sizes not listed use `model`. */
    models: z.object({ S: z.string().min(1), M: z.string().min(1), L: z.string().min(1) }).partial().strict().optional(),
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;

export const RoleSchema = z
  .object({
    route: name,
    /** More routes (other vendors) this role uses as equals: each task goes to the one with the most headroom. */
    pool: z.array(name).default([]),
    mode: z.enum(["readonly", "write"]).default("write"),
    concurrency: z.number().int().min(1).max(16).default(1),
    paths_allow: z.array(z.string()).optional(),
    paths_deny: z.array(z.string()).default([]),
    instructions: z.string().default(""),
    independent_of: z.array(name).default([]),
    fallback: z.enum(["ask", "auto", "none"]).default("none"),
    fallback_routes: z.array(name).default([]),
  })
  .strict();
export type Role = z.infer<typeof RoleSchema>;

export const ManualBudgetSchema = z
  .object({
    unit: z.enum(["runs", "minutes", "pct"]),
    per: z.enum(["day", "week", "5h"]),
    amount: z.number().positive(),
  })
  .strict();
export type ManualBudget = z.infer<typeof ManualBudgetSchema>;

export const RouteLimitsSchema = z
  .object({
    window_5h_cap_pct: z.number().min(0).max(100).optional(),
    window_7d_cap_pct: z.number().min(0).max(100).optional(),
    manual_budget: ManualBudgetSchema.optional(),
  })
  .strict();
export type RouteLimits = z.infer<typeof RouteLimitsSchema>;

const quietHours = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'expected "HH:MM-HH:MM"');

export const LimitsSchema = z
  .object({
    max_attempts_per_task: z.number().int().min(1).default(3),
    max_task_minutes: z.number().positive().default(60),
    max_parallel_workers: z.number().int().min(1).default(3),
    max_tasks_per_burst: z.number().int().min(1).default(6),
    /** Input tokens a vendor session may carry before harness starts a fresh one from the board and a handoff. */
    /** Task sizes the reviewer looks at; other sizes merge once their checks pass. */
    review_sizes: z.array(z.enum(["S", "M", "L"])).default(["S", "M", "L"]),
    /** Rounds of follow-ups the lead may set for one request (the first round is the request itself). */
    lead_rounds: z.number().int().min(1).max(5).default(2),
    /** Follow-up jobs the lead may set per round. */
    lead_followups: z.number().int().min(0).max(10).default(3),
    max_delegated_children: z.number().int().min(0).max(16).default(8),
    max_concurrent_children: z.number().int().min(1).max(8).default(3),
    fresh_session_after_tokens: z.number().int().min(10_000).default(400_000),
    quiet_hours: quietHours.optional(),
    routes: z.record(name, RouteLimitsSchema).default({}),
  })
  .strict();
export type Limits = z.infer<typeof LimitsSchema>;

export const BurstSchema = z
  .object({
    enabled: z.boolean().default(true),
    resume_jitter_seconds: z.tuple([z.number().min(0), z.number().min(0)]).default([5, 120]),
    safety_margin_pct: z.number().min(0).max(100).default(5),
    weekly_reserve_pct: z.number().min(0).max(100).default(10),
    cold_cost_pct: z
      .object({ S: z.number(), M: z.number(), L: z.number() })
      .strict()
      .default({ S: 6, M: 12, L: 25 }),
  })
  .strict();
export type Burst = z.infer<typeof BurstSchema>;

export const UnattendedSchema = z.enum(["allow", "ask", "deny"]);
export type Unattended = z.infer<typeof UnattendedSchema>;

export const ApprovalCategorySchema = z.enum([
  "protected_paths",
  "new_dependencies",
  "merge_to_main",
  "budget_increase",
  "new_scope",
]);
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;

export const PolicySchema = z
  .object({
    autonomy: z.enum(["observe", "assisted", "approved-scope"]).default("approved-scope"),
    unattended: z.record(name, UnattendedSchema).default({}),
    require_approval: z
      .array(ApprovalCategorySchema)
      .default(["protected_paths", "new_dependencies", "merge_to_main", "budget_increase"]),
    protected_paths: z
      .array(z.string())
      .default([".github/**", "**/.env*", "harness.yaml", ".harness/checks.yaml"]),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export const UiSchema = z.object({ tmux: z.boolean().default(false) }).strict();

export const HarnessConfigSchema = z
  .object({
    version: z.literal(1),
    project: name,
    integration_branch: z.string().default("harness/integration"),
    /** "auto": every merge that passes lands in the base branch at once (fast-forward, or a merge commit on a clean checkout). */
    land: z.enum(["manual", "auto"]).default("auto"),
    base_branch: z.string().default("main"),
    routes: z.record(name, RouteSchema),
    roles: z.record(name, RoleSchema),
    limits: LimitsSchema.default({}),
    burst: BurstSchema.default({}),
    policy: PolicySchema.default({}),
    ui: UiSchema.default({}),
  })
  .strict();
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type HarnessConfigInput = z.input<typeof HarnessConfigSchema>;

export const CheckSchema = z
  .object({
    id: name,
    argv: z.array(z.string()).min(1),
    timeout_s: z.number().positive().default(300),
    required: z.boolean().default(true),
    scope: z.enum(["all", "changed"]).default("all"),
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

export const ChecksConfigSchema = z
  .object({
    version: z.literal(1),
    checks: z.array(CheckSchema),
    setup: z.array(z.object({ argv: z.array(z.string()).min(1), timeout_s: z.number().positive().default(600) }).strict()).default([]),
    env_pass: z.array(z.string()).default(["CI", "NODE_ENV"]),
  })
  .strict();
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;
