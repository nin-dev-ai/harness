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
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;

export const RoleSchema = z
  .object({
    route: name,
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
