import { z } from "zod";
import { roleGuide } from "@harness/core";
import { bullet, render } from "./prompts.js";
import { extractJson } from "./validate.js";

const key = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

export const PlannedTaskSchema = z.object({
  key,
  title: z.string().min(3).max(200),
  role: z.string(),
  size: z.enum(["S", "M", "L"]).default("M"),
  depends_on: z.array(key).default([]),
  acceptance: z.array(z.string()).default([]),
  files_hint: z.array(z.string()).default([]),
  contract_ref: z.string().nullable().optional().transform((v) => v ?? null),
  description: z.string().default(""),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

export const PlanOutputSchema = z.object({
  summary: z.string().default(""),
  tasks: z.array(PlannedTaskSchema).min(1).max(50),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export const PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["summary", "tasks"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "title", "role", "size", "depends_on", "acceptance", "files_hint", "contract_ref", "description"],
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          role: { type: "string" },
          size: { type: "string", enum: ["S", "M", "L"] },
          depends_on: { type: "array", items: { type: "string" } },
          acceptance: { type: "array", items: { type: "string" } },
          files_hint: { type: "array", items: { type: "string" } },
          contract_ref: { type: ["string", "null"] },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export interface RoleInfo {
  name: string;
  mode: "readonly" | "write";
  instructions: string;
  pathsAllow: string[] | undefined;
  concurrency?: number;
}

type PlanPromptInput = { document: string; roles: RoleInfo[]; repo: string; existing: { id: string; title: string; role: string; state: string }[] };

const roleLine = (r: RoleInfo, withConcurrency: boolean) =>
  `\`${r.name}\`: ${roleGuide(r.name, r.instructions) || "(no instructions)"}; may write ${r.pathsAllow?.join(", ") ?? "anywhere"}` +
  (withConcurrency ? `; ${r.concurrency ?? 1} at once` : "");

function planVars(i: PlanPromptInput, withConcurrency: boolean) {
  return {
    roles: bullet(i.roles.filter((r) => r.mode === "write").map((r) => roleLine(r, withConcurrency))),
    repo: i.repo.trim() || "(empty)",
    existing: bullet(i.existing.map((t) => `${t.id} [${t.state}] ${t.role}: ${t.title}`)),
    document: i.document.trim(),
  };
}

/** Prompt for `harness plan <file>`: a document split into a full task graph. */
export function buildPlanPrompt(i: PlanPromptInput): string {
  return render("plan", planVars(i, false));
}

/** Prompt for a chat message to the team: one parallel mini prompt per agent, fast. */
export function buildDispatchPrompt(i: PlanPromptInput): string {
  return render("dispatch", planVars(i, true));
}

export function buildPlanRetryPrompt(errors: string[]): string {
  return render("plan-retry", { errors: bullet(errors) });
}

export type PlanResult = { ok: true; plan: PlanOutput } | { ok: false; errors: string[] };

/** Find a cycle among planned task keys. */
function cycle(tasks: PlannedTask[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.key, t.depends_on]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (k: string): string[] | undefined => {
    if (state.get(k) === 2) return undefined;
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 1);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(k, 2);
    return undefined;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return undefined;
}

/**
 * Validate planner output: schema, known write roles, unique keys, known
 * dependencies, no cycles. Errors are phrased so they can be sent back.
 */
export function validatePlan(structured: unknown, text: string, roles: RoleInfo[]): PlanResult {
  const candidate = structured ?? extractJson(text);
  if (candidate === undefined) return { ok: false, errors: ["the reply contained no JSON object"] };
  const r = PlanOutputSchema.safeParse(candidate);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const errors: string[] = [];
  const writeRoles = new Set(roles.filter((x) => x.mode === "write").map((x) => x.name));
  const keys = new Set<string>();
  for (const t of r.data.tasks) {
    if (keys.has(t.key)) errors.push(`duplicate task key "${t.key}"`);
    keys.add(t.key);
    if (!writeRoles.has(t.role)) errors.push(`task "${t.key}": role "${t.role}" is not one of ${[...writeRoles].join(", ")}`);
  }
  for (const t of r.data.tasks) for (const d of t.depends_on) if (!keys.has(d)) errors.push(`task "${t.key}": depends_on unknown key "${d}"`);
  const c = cycle(r.data.tasks);
  if (c) errors.push(`dependency cycle: ${c.join(" -> ")}`);
  return errors.length ? { ok: false, errors } : { ok: true, plan: r.data };
}

/** Planned tasks in dependency order (dependencies first), stable otherwise. */
export function topoOrder(tasks: PlannedTask[]): PlannedTask[] {
  const done = new Set<string>();
  const out: PlannedTask[] = [];
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const visit = (t: PlannedTask) => {
    if (done.has(t.key)) return;
    done.add(t.key);
    for (const d of t.depends_on) visit(byKey.get(d)!);
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}
