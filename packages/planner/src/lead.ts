import { z } from "zod";
import { roleGuide } from "@harness/core";
import { bullet, render } from "./prompts.js";
import type { RoleInfo } from "./plan.js";
import { extractJson } from "./validate.js";

export const FollowupSchema = z.object({
  title: z.string().min(3).max(200),
  role: z.string().default(""),
  description: z.string().default(""),
  acceptance: z.array(z.string()).default([]),
  files_hint: z.array(z.string()).default([]),
});
export type Followup = z.infer<typeof FollowupSchema>;

export const LeadOutputSchema = z.object({
  status: z.string().min(1),
  done: z.boolean().default(false),
  followups: z.array(FollowupSchema).default([]),
});
export type LeadOutput = z.infer<typeof LeadOutputSchema>;

export const LEAD_JSON_SCHEMA = {
  type: "object",
  required: ["status", "done", "followups"],
  additionalProperties: false,
  properties: {
    status: { type: "string" },
    done: { type: "boolean" },
    followups: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "role", "description", "acceptance", "files_hint"],
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          role: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          files_hint: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface LeadTaskView {
  id: string;
  title: string;
  role: string;
  state: string;
  summary?: string | undefined;
  files?: string[] | undefined;
  reason?: string | undefined;
}

export function buildLeadPrompt(i: { request: string; tasks: LeadTaskView[]; board: string; roles: RoleInfo[]; max: number }): string {
  return render("lead", {
    request: i.request.trim() || "(no request text)",
    tasks: bullet(
      i.tasks.map(
        (t) =>
          `${t.id} [${t.state.toLowerCase()}] \`${t.role}\`: ${t.title}` +
          (t.summary ? `\n  did: ${t.summary.replace(/\s+/g, " ").slice(0, 600)}` : "") +
          (t.files?.length ? `\n  changed: ${t.files.slice(0, 20).join(", ")}` : "") +
          (t.reason ? `\n  needs the person: ${t.reason}` : ""),
      ),
    ),
    board: i.board.trim() || "(empty)",
    roles: bullet(i.roles.filter((r) => r.mode === "write").map((r) => `\`${r.name}\`: ${roleGuide(r.name, r.instructions) || "(no instructions)"}; may write ${r.pathsAllow?.join(", ") ?? "anywhere"}`)),
    max: i.max,
    lastRound: i.max === 0 ? " (this was the last round: return none)" : "",
  });
}

export type LeadResult = { ok: true; lead: LeadOutput } | { ok: false; errors: string[] };

/**
 * Validate the lead's reply. Unknown roles are cleared (harness routes those
 * follow-ups itself); follow-ups past the cap are dropped, never run.
 */
export function validateLead(structured: unknown, text: string, roles: RoleInfo[], max: number): LeadResult {
  const candidate = structured ?? extractJson(text);
  if (candidate === undefined) return { ok: false, errors: ["the reply contained no JSON object"] };
  const r = LeadOutputSchema.safeParse(candidate);
  if (!r.success) return { ok: false, errors: r.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`) };
  const writers = new Set(roles.filter((x) => x.mode === "write").map((x) => x.name));
  const followups = (r.data.done ? [] : r.data.followups).slice(0, Math.max(0, max)).map((f) => ({ ...f, role: writers.has(f.role) ? f.role : "" }));
  return { ok: true, lead: { ...r.data, followups } };
}
