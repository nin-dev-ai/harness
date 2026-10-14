import { z } from "zod";
import { bullet, render } from "./prompts.js";
import { extractJson } from "./validate.js";

export const ProposedRoleSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  route: z.string(),
  mode: z.enum(["readonly", "write"]),
  paths_allow: z.array(z.string()).nullable().optional().transform((v) => v ?? undefined),
  instructions: z.string().default(""),
});
export type ProposedRole = z.infer<typeof ProposedRoleSchema>;

export const RolesProposalSchema = z.object({
  rationale: z.string().default(""),
  roles: z.array(ProposedRoleSchema).min(1).max(12),
});
export type RolesProposal = z.infer<typeof RolesProposalSchema>;

export const ROLES_JSON_SCHEMA = {
  type: "object",
  required: ["rationale", "roles"],
  additionalProperties: false,
  properties: {
    rationale: { type: "string" },
    roles: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "route", "mode", "paths_allow", "instructions"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          route: { type: "string" },
          mode: { type: "string", enum: ["readonly", "write"] },
          paths_allow: { type: ["array", "null"], items: { type: "string" } },
          instructions: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildRolesPrompt(i: { routes: { name: string; vendor: string; auth: string; model: string | null }[]; repo: string; document: string }): string {
  return render("roles", {
    routes: bullet(i.routes.map((r) => `\`${r.name}\`: ${r.vendor} (${r.auth}${r.model ? `, ${r.model}` : ""})`)),
    repo: i.repo.trim() || "(empty)",
    document: i.document.trim() || "(none)",
  });
}

export type RolesResult = { ok: true; proposal: RolesProposal } | { ok: false; errors: string[] };

export function validateRoles(structured: unknown, text: string, routes: string[]): RolesResult {
  const candidate = structured ?? extractJson(text);
  if (candidate === undefined) return { ok: false, errors: ["the reply contained no JSON object"] };
  const r = RolesProposalSchema.safeParse(candidate);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const errors: string[] = [];
  const names = new Set<string>();
  for (const role of r.data.roles) {
    if (names.has(role.name)) errors.push(`duplicate role "${role.name}"`);
    names.add(role.name);
    if (!routes.includes(role.route)) errors.push(`role "${role.name}": route "${role.route}" is not one of ${routes.join(", ")}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, proposal: r.data };
}
